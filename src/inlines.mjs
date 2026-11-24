/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { readResponseText } from './decompress.mjs';
import {
  BACKEND_FETCH_TIMEOUT,
  ffetch,
  FetchTimeoutError,
  getTimeout,
  INLINE_FETCH_TIMEOUT,
  NO_STORE_HEADERS,
  toHeaderValue,
  upstreamError,
  withTimeout,
} from './inline-support.mjs';

/**
 * @type {string[]}
 */
const INLINE_ORIGINS = [
  '.aem.live',
  '.aem.page',
  '.adobeaem.workers.dev',
  'pipeline-cloudflare.adobecommerce.live',
];

const ANCHOR_RE = /<a(?=[\s>])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/a>/gi;
/**
 * Max chars after `</a>` to look for a matching `</p>` / `</div>`
 * (avoids scanning the rest of the document).
 */
const WRAPPER_CLOSE_LOOKAHEAD = 1024;
const CLOSE_WRAPPER_RE = /^\s*<\/(?<tag>p|div)>/i;
/**
 * Open tag interior between `<` and `>` for `<p` / `<div`
 * (same constraint as former OPEN_WRAPPER_RE).
 */
const OPEN_WRAPPER_INNER_RE = /^(?<tag>p|div)(?:\s[^>]*)?$/i;
const OPEN_TAG_RE = /^<a(?=[\s>])(?:[^>"']|"[^"]*"|'[^']*')*>/i;
const HREF_ATTR_RE = /\shref\s*=\s*(["'])(?<href>\/[^"'<>]*)\1/i;

/**
 * Pull out the nav/footer location from the meta tags, if present.
 * Exclude resources if they dont also exist in the body.
 *
 * @param {string} markup
 * @returns {{nav?: string, footer?: string}} paths to resources to fetch
 */
function extractInlineMeta(markup) {
  const hasNavTag = markup.includes('<header></header>');
  const hasFooterTag = markup.includes('<footer></footer>');
  /** @type {{nav?: string, footer?: string}} */
  const meta = {};
  if (hasNavTag) {
    const navPath = markup.match(/<meta name="nav" content="([^"]+)"/);
    if (navPath) {
      // eslint-disable-next-line prefer-destructuring
      meta.nav = navPath[1];
    }
  }
  if (hasFooterTag) {
    const footerPath = markup.match(/<meta name="footer" content="([^"]+)"/);
    if (footerPath) {
      // eslint-disable-next-line prefer-destructuring
      meta.footer = footerPath[1];
    }
  }
  return meta;
}

/**
 * Indent each line at the beginning by the number of spaces.
 * @param {string} markup
 * @param {number} indentCount
 * @returns {string}
 */
function indent(markup, indentCount) {
  return markup.replace(/^/gm, ' '.repeat(indentCount));
}

/**
 * Preserve the first line as-is because the line's leading whitespace remains
 * outside the replacement range in the source markup.
 * @param {string} markup
 * @param {number} indentCount
 * @returns {string}
 */
function indentSubsequentLines(markup, indentCount) {
  return markup.replace(/\n/g, `\n${' '.repeat(indentCount)}`);
}

/**
 * Track the most recent `last-modified` across responses.
 * @param {{ value: number }} tracker latest last-modified as epoch ms
 * @param {{ get: (name: string) => string | null | undefined }} headers
 */
function mergeLastModified(tracker, headers) {
  const ts = Date.parse(headers.get('last-modified'));
  if (ts > tracker.value) {
    tracker.value = ts;
  }
}

/**
 * Advance the response's `last-modified` when an inlined resource is newer than the origin.
 * @param {Headers} headers headers being built for the new response
 * @param {Headers} original headers of the origin response
 * @param {{ value: number }} tracker latest inlined last-modified as epoch ms
 */
function applyLastModified(headers, original, tracker) {
  if (tracker.value > Date.parse(original.get('last-modified'))) {
    headers.set('last-modified', new Date(tracker.value).toUTCString());
  }
}

/**
 * @param {Context} ctx
 * @returns {string[]}
 */
function getInlinePaths(ctx) {
  return ctx.config.inlineFragments?.paths || [];
}

/**
 * @param {string} markup
 * @param {number} index
 * @returns {number}
 */
function getIndentCount(markup, index) {
  const lineStart = markup.lastIndexOf('\n', index - 1) + 1;
  let indentCount = 0;
  for (let i = lineStart; i < index; i += 1) {
    const ch = markup[i];
    if (ch === ' ') {
      indentCount += 1;
    } else if (ch === '\t') {
      indentCount += 2;
    } else {
      return 0;
    }
  }
  return indentCount;
}

/**
 * @param {Context} ctx
 * @param {string} path
 * @returns {URL}
 */
function getInlineUrl(ctx, path) {
  const url = new URL(path, `${ctx.config.protocol}://${ctx.config.origin}`);
  url.hash = '';
  if (!url.pathname.endsWith('.plain.html')) {
    url.pathname = `${url.pathname}.plain.html`;
  }
  return url;
}

/**
 * Returns the normalized href ending with #inline if it should be inlined, or null.
 * Path-matched hrefs get #inline appended; hrefs already ending with #inline pass through.
 * @param {string} href
 * @param {string[]} inlinePaths
 * @returns {string|null}
 */
function normalizeInlineHref(href, inlinePaths) {
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/\\')) {
    return null;
  }
  if (href.endsWith('#inline')) {
    return href;
  }
  if (inlinePaths.length) {
    const qIdx = href.indexOf('?');
    const hIdx = href.indexOf('#');
    const endIdx = Math.min(
      qIdx >= 0 ? qIdx : href.length,
      hIdx >= 0 ? hIdx : href.length,
    );
    const pathname = href.slice(0, endIdx);
    if (inlinePaths.some((path) => pathname.startsWith(path))) {
      const withoutHash = hIdx >= 0 ? href.slice(0, hIdx) : href;
      return `${withoutHash}#inline`;
    }
  }
  return null;
}

/**
 * @param {string} anchorMarkup
 * @returns {string}
 */
function extractHref(anchorMarkup) {
  const openTag = anchorMarkup.match(OPEN_TAG_RE)?.[0];
  if (!openTag) {
    return '';
  }

  return openTag.match(HREF_ATTR_RE)?.groups?.href || '';
}

/**
 * @param {string} markup
 * @param {RegExp} re
 * @returns {{ index: number, text: string, groups: Record<string, string> }[]}
 */
function collectMatches(markup, re) {
  const matches = [];
  re.lastIndex = 0;
  let match = re.exec(markup);
  while (match) {
    matches.push({
      index: match.index,
      text: match[0],
      groups: match.groups || {},
    });
    match = re.exec(markup);
  }
  return matches;
}

/**
 * @param {{ start: number, end: number }[]} replacements
 * @param {number} index
 * @returns {boolean}
 */
function replacementExistsAt(replacements, index) {
  return replacements.some(({ start, end }) => index >= start && index < end);
}

/**
 * If the anchor at [start, end) is directly inside a minimal `<p>` or `<div>` wrapper
 * (only whitespace between the open `>` and `<a`, and optional whitespace then `</p|div>`
 * after `</a>`), return that wrapper's span in markup. Uses index scans instead of slicing
 * the entire prefix.
 *
 * @param {string} markup
 * @param {number} start - index of `<a`
 * @param {number} end - index after `</a>`
 * @returns {{ start: number, end: number } | null}
 */
function findImmediateWrapper(markup, start, end) {
  let i = start - 1;
  while (i >= 0 && /\s/.test(markup[i])) {
    i -= 1;
  }
  if (i < 0 || markup[i] !== '>') {
    return null;
  }
  const gt = i;
  let lt = gt - 1;
  while (lt >= 0 && markup[lt] !== '<') {
    lt -= 1;
  }
  if (lt < 0) {
    return null;
  }
  const inner = markup.slice(lt + 1, gt);
  const openMatch = inner.match(OPEN_WRAPPER_INNER_RE);
  if (!openMatch?.groups?.tag) {
    return null;
  }
  const openTag = openMatch.groups.tag.toLowerCase();

  const afterLimit = Math.min(markup.length, end + WRAPPER_CLOSE_LOOKAHEAD);
  const closeRegion = markup.slice(end, afterLimit);
  const closeMatch = closeRegion.match(CLOSE_WRAPPER_RE);
  if (!closeMatch?.groups?.tag) {
    return null;
  }
  if (closeMatch.groups.tag.toLowerCase() !== openTag) {
    return null;
  }

  return {
    start: lt,
    end: end + closeMatch[0].length,
  };
}

/**
 * @param {string} markup
 * @param {{ start: number, end: number, replacement: string }[]} replacements
 * @returns {string}
 */
function applyReplacements(markup, replacements) {
  return replacements
    .sort((a, b) => b.start - a.start)
    .reduce((acc, { start, end, replacement }) => `${acc.slice(0, start)}${replacement}${acc.slice(end)}`, markup);
}

/**
 * @param {Response} response
 * @returns {boolean}
 */
function isInlineable(response) {
  return response.status === 200 && !!response.headers.get('content-type')?.includes('text/html');
}

/**
 * Fetch a resource to inline, including its body when it can be inlined. On timeout
 * (headers or body), network error, or when the request deadline has passed, log a
 * warning, record the error (sent as `x-inline-error`) and return null so the inline
 * is skipped. Any skipped inline, or one without a valid `last-modified`, sets
 * `ctx.attributes.inlineDateUnknown`.
 * @param {Context} ctx
 * @param {string[]} inlineErrors
 * @param {'fragment' | 'header' | 'footer'} kind
 * @param {string} path
 * @param {URL} url
 * @param {Record<string, unknown>} init
 * @returns {Promise<{ response: Response, text?: string }|null>}
 */
async function fetchInline(ctx, inlineErrors, kind, path, url, init) {
  const timeout = getTimeout(ctx, INLINE_FETCH_TIMEOUT);
  if (timeout <= 0) {
    const message = `${kind} skipped (${path}): request deadline exceeded`;
    ctx.log.warn(`${message} (host=${url.host}, request=${ctx.requestId})`);
    inlineErrors.push(toHeaderValue(message));
    ctx.attributes.inlineDateUnknown = true;
    return null;
  }
  const start = Date.now();
  try {
    return await ffetch(url.toString(), init, {
      timeout,
      read: async (response) => {
        if (!isInlineable(response)) {
          ctx.attributes.inlineDateUnknown = true;
          const message = `${kind} fetch failed (${path}): ${response.status}`;
          ctx.log.warn(message);
          inlineErrors.push(toHeaderValue(message));
          return { response };
        }
        // without a date the merged last-modified can't vouch for this inline
        if (Number.isNaN(Date.parse(response.headers.get('last-modified')))) {
          ctx.attributes.inlineDateUnknown = true;
        }
        return { response, text: await response.text() };
      },
    });
  } catch (e) {
    const message = e instanceof FetchTimeoutError
      ? `${kind} fetch timeout (${path}) after ${timeout}ms`
      : `${kind} fetch error (${path}): ${e.message}`;
    ctx.log.warn(`${message} (host=${url.host}, elapsed=${Date.now() - start}ms, request=${ctx.requestId})`);
    inlineErrors.push(toHeaderValue(message));
    ctx.attributes.inlineDateUnknown = true;
    return null;
  }
}

/**
 * Cache headers dropped from a degraded response (see {@link applyInlineErrors}).
 */
const CDN_CACHE_HEADERS = [
  'surrogate-control',
  'cdn-cache-control',
  'cloudflare-cdn-cache-control',
  'edge-control',
  'expires',
];

/**
 * Report skipped inlines and prevent downstream caches from storing incomplete pages.
 * @param {Headers} headers
 * @param {string[]} inlineErrors
 */
function applyInlineErrors(headers, inlineErrors) {
  if (inlineErrors.length) {
    headers.set('x-inline-error', toHeaderValue(inlineErrors.join(', ')));
    headers.set('cache-control', NO_STORE_HEADERS['cache-control']);
    CDN_CACHE_HEADERS.forEach((name) => headers.delete(name));
  }
}

/**
 * @param {Context} ctx
 * @param {{ value: number }} lastModified
 * @param {string[]} inlineErrors
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function fetchFragmentMarkup(ctx, lastModified, inlineErrors, path) {
  const url = getInlineUrl(ctx, path);
  const tagResponse = await fetchInline(ctx, inlineErrors, 'fragment', path.replace(/#inline$/, ''), url, {
    redirect: 'manual',
    headers: {
      'accept-encoding': 'identity',
      'x-byo-cdn-type': ctx.info.headers['x-byo-cdn-type'],
      'x-forwarded-host': ctx.info.headers['x-forwarded-host'],
      ...(ctx.info.headers['x-push-invalidation']
        ? { 'x-push-invalidation': ctx.info.headers['x-push-invalidation'] } : {}),
      ...(ctx.info.headers.authorization ? { authorization: ctx.info.headers.authorization } : {}),
    },
    cf: {
      cacheEverything: true,
    },
  });
  if (!tagResponse) {
    return null;
  }
  const { response, text } = tagResponse;
  if (text === undefined) {
    ctx.log.warn(`Failed to inline fragment from ${path}: ${response.status}`);
    return null;
  }

  mergeLastModified(lastModified, response.headers);
  return text;
}

/**
 * Fetch a nav or footer resource and track its modification date.
 * @param {Context} ctx
 * @param {{ value: number }} lastModified
 * @param {string[]} inlineErrors
 * @param {string} path path to resource to fetch
 * @param {'header' | 'footer'} tag
 * @returns {Promise<string|null>}
 */
async function fetchTagMarkup(ctx, lastModified, inlineErrors, path, tag) {
  const ppath = path.endsWith('.plain.html') ? path : `${path}.plain.html`;
  const origin = new URL(`${ctx.config.protocol}://${ctx.config.origin}`);
  const url = new URL(ppath, origin);
  const isEdgeOrigin = url.protocol === 'https:'
    && (url.hostname.endsWith('.aem.page')
      || url.hostname.endsWith('.aem.live')
      || url.hostname.endsWith('.adobeaem.workers.dev'));
  const authorization = isEdgeOrigin && url.origin === origin.origin
    ? ctx.info.headers.authorization
    : undefined;
  const tagResponse = await fetchInline(ctx, inlineErrors, tag, path, url, {
    // Keep credentials on the page's backend, including when it redirects.
    ...(authorization ? { redirect: 'manual' } : {}),
    headers: {
      'x-byo-cdn-type': ctx.info.headers['x-byo-cdn-type'],
      'x-forwarded-host': ctx.info.headers['x-forwarded-host'],
      ...(ctx.info.headers['x-push-invalidation']
        ? { 'x-push-invalidation': ctx.info.headers['x-push-invalidation'] } : {}),
      ...(authorization ? { authorization } : {}),
    },
    cf: {
      cacheEverything: true,
    },
  });
  if (!tagResponse) {
    return null;
  }
  const { response, text: tagMarkup } = tagResponse;
  if (tagMarkup === undefined) {
    ctx.log.warn(`Failed to inline ${tag} from ${path}: ${response.status}`);
    return null;
  }

  mergeLastModified(lastModified, response.headers);
  return tagMarkup.trim();
}

/**
 * Inline comma-separated nav or footer resources in metadata order.
 * @param {Context} ctx
 * @param {string} markup
 * @param {{ value: number }} lastModified
 * @param {string[]} inlineErrors
 * @param {string | undefined} paths
 * @param {'header' | 'footer'} tag
 * @returns {Promise<string>}
 */
async function inlineTag(ctx, markup, lastModified, inlineErrors, paths, tag) {
  if (!paths) return markup;

  const tagMarkups = await Promise.all(paths.split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => fetchTagMarkup(ctx, lastModified, inlineErrors, path, tag)));
  const content = tagMarkups.filter((text) => text !== null);
  if (!content.length) return markup;

  const indentMatch = markup.match(new RegExp(`([^\\S\\n]*)<${tag}>`));
  /* c8 ignore next */
  const indentCount = indentMatch?.[1]?.length ?? 0;

  markup = markup.replace(`<${tag}></${tag}>`, `<${tag}>
${content.map((text) => indent(text, indentCount + 2)).join('\n')}
${' '.repeat(indentCount)}</${tag}>`);
  return markup;
}

/**
 * @param {Context} ctx
 * @param {string} markup
 * @param {{ value: number }} lastModified
 * @param {string[]} inlineErrors
 * @returns {Promise<string>}
 */
async function inlineFragments(ctx, markup, lastModified, inlineErrors) {
  const inlinePaths = getInlinePaths(ctx);
  if (inlinePaths.length === 0 && !markup.includes('#inline')) {
    return markup;
  }

  const anchorMatches = collectMatches(markup, ANCHOR_RE)
    .map((match) => {
      const href = normalizeInlineHref(extractHref(match.text), inlinePaths);
      return href ? { ...match, href } : null;
    })
    .filter(Boolean);

  if (!anchorMatches.length) return markup;

  // Fetch unique fragments only, all in parallel
  const uniqueHrefs = [...new Set(anchorMatches.map((m) => m.href))];
  /** @type {Map<string, string>} */
  const fragmentMap = new Map();
  await Promise.all(uniqueHrefs.map(async (href) => {
    const fm = await fetchFragmentMarkup(ctx, lastModified, inlineErrors, href);
    if (fm) {
      fragmentMap.set(href, fm);
    }
  }));

  if (!fragmentMap.size) return markup;

  const replacements = anchorMatches
    .map((match) => {
      const fragmentMarkup = fragmentMap.get(match.href);
      if (!fragmentMarkup) return null;

      const wrapper = findImmediateWrapper(markup, match.index, match.index + match.text.length);
      if (wrapper) {
        return {
          start: wrapper.start,
          end: wrapper.end,
          replacement: indentSubsequentLines(
            fragmentMarkup.trim(),
            getIndentCount(markup, wrapper.start),
          ),
        };
      }
      return {
        start: match.index,
        end: match.index + match.text.length,
        replacement: fragmentMarkup.trim(),
      };
    })
    .filter(Boolean);

  const dedupedReplacements = replacements.filter((replacement, index) => !replacementExistsAt(
    replacements.slice(0, index),
    replacement.start,
  ));
  return dedupedReplacements.length ? applyReplacements(markup, dedupedReplacements) : markup;
}

/**
 * Determine the compression hint based on client's Accept-Encoding.
 * @param {Context} ctx
 * @returns {string|undefined} 'gzip' or 'deflate' if supported, undefined otherwise
 */
function getCompressionHint(ctx) {
  const acceptEncoding = ctx.info.headers['accept-encoding']?.toLowerCase() || '';
  if (acceptEncoding.includes('gzip')) {
    return 'gzip';
  }
  if (acceptEncoding.includes('deflate')) {
    return 'deflate';
  }
  return undefined;
}

/**
 * Check if the config defines inlines.
 * @param {Context} ctx
 * @returns {boolean}
 */
export function inlineConfigured(ctx) {
  const { config } = ctx;
  return !!config.inlineNav || !!config.inlineFooter || !!config.inlineFragments;
}

/**
 * Whether the request is for an HTML page that {@link inlineResources} may change.
 * @param {Context} ctx
 * @param {URL} beurl
 * @returns {boolean}
 */
export function canInline(ctx, beurl) {
  if (!inlineConfigured(ctx) || ctx.info.method !== 'GET') {
    return false;
  }
  if (!INLINE_ORIGINS.some((origin) => beurl.origin.endsWith(origin))) {
    return false;
  }
  const lastSegment = beurl.pathname.split('/').pop();
  return !lastSegment.includes('.')
    || (lastSegment.endsWith('.html') && !lastSegment.endsWith('.plain.html'));
}

/**
 * If config defines inlines, and the original requested resource is:
 *   0. a GET request
 *   1. an HTML document
 *   2. coming from *.aem.live, *.aem.page, *.adobeaem.workers.dev,
 *      or pipeline-cloudflare.adobecommerce.live
 *   3. contains a <meta name="nav|footer" content="..."> tag
 *   4. contains a <header> or <footer> element
 *   5. is not a .plain.html resource
 * Then fetch and inline the nav and/or footer markup into the response body.
 *
 * Additionally, if `inlineFragments` is configured, inline fragment links
 * (by path prefix or #inline suffix) into the markup.
 *
 * @param {Context} ctx
 * @param {URL} beurl
 * @param {Response} response
 * @returns {Promise<Response>}
 */
export default async function inlineResources(ctx, beurl, response) {
  const { info } = ctx;
  if (!inlineConfigured(ctx)) {
    return response;
  }

  if (info.method !== 'GET') {
    return response;
  }

  if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) {
    return response;
  }

  if (!INLINE_ORIGINS.some((origin) => beurl.origin.endsWith(origin))) {
    return response;
  }

  if (beurl.pathname.endsWith('.plain.html')) {
    return response;
  }

  // get the markup - automatically handles decompression if needed.
  // The body is buffered here, so bound the read by the backend timeout / deadline.
  let markup;
  const timeout = getTimeout(ctx, BACKEND_FETCH_TIMEOUT);
  const start = Date.now();
  try {
    markup = await withTimeout(readResponseText(response, ctx), timeout);
  } catch (error) {
    throw upstreamError(ctx, {
      stage: 'backend', host: beurl.host, error, timeout, start,
    });
  }
  const meta = extractInlineMeta(markup);
  const navPath = ctx.config.inlineNav ? meta.nav : undefined;
  const footerPath = ctx.config.inlineFooter ? meta.footer : undefined;

  const lastModified = { value: ctx.configLastModified || 0 };
  // inlines skipped because of a timeout or network error
  /** @type {string[]} */
  const inlineErrors = [];

  if (ctx.config.inlineFragments) {
    markup = await inlineFragments(ctx, markup, lastModified, inlineErrors);
  }

  markup = await inlineTag(ctx, markup, lastModified, inlineErrors, navPath, 'header');
  markup = await inlineTag(ctx, markup, lastModified, inlineErrors, footerPath, 'footer');

  const compressionHint = getCompressionHint(ctx);
  // Remove content-encoding since we decompressed the response
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('etag');
  headers.delete('content-md5');
  headers.delete('digest');
  if (compressionHint) {
    headers.set('x-compress-hint', compressionHint);
  }

  applyLastModified(headers, response.headers, lastModified);
  applyInlineErrors(headers, inlineErrors);

  // Return uncompressed markup - CDN will handle compression via x-compress-hint
  return new Response(markup, {
    status: response.status,
    headers,
  });
}
