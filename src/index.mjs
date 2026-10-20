/*
 * Copyright 2022 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

'use strict';

const getExtension = (path) => {
  const basename = path.split('/').pop();
  const pos = basename.lastIndexOf('.');
  return (basename === '' || pos < 1) ? '' : basename.slice(pos + 1);
};

const isMediaRequest = (url) => /\/media_[0-9a-f]{40,}[/a-zA-Z0-9_-]*\.[0-9a-z]+$/.test(url.pathname);
const isRUMRequest = (url) => /\/\.(rum|optel)\/.*/.test(url.pathname);

const MEDIA_REF_REGEX = /media_([0-9a-f]{40,})[/a-zA-Z0-9_-]*\./g;
const MEDIA_PATH_REGEX = /\/media_([0-9a-f]{40,})[/a-zA-Z0-9_-]*\.[0-9a-z]+$/;

/**
 * Extracts the unique media hashes of all "media_<hash>..." references in a string.
 * @param {string} text HTML, JSON or a header value
 * @returns {string[]} unique hashes
 */
const extractMediaHashes = (text) => {
  if (!text) return [];
  return [...new Set([...text.matchAll(MEDIA_REF_REGEX)].map((m) => m[1]))];
};

/**
 * Registers the given hashes in the published media KV store. Hashes that already
 * exist are left untouched. New ones get a JSON value { timestamp, path }.
 */
const registerMediaHashes = async (env, hashes, pathname) => {
  if (!env.PUBLISHED_MEDIA || !hashes.length) return;
  await Promise.all(hashes.map(async (hash) => {
    if (await env.PUBLISHED_MEDIA.get(hash) === null) {
      await env.PUBLISHED_MEDIA.put(hash, JSON.stringify({
        timestamp: new Date().toISOString(),
        path: pathname,
      }));
    }
  }));
};


const handleRequest = async (request, env, ctx) => {
  const url = new URL(request.url);
  if (url.port) {
    // Cloudflare opens a couple more ports than 443, so we redirect visitors
    // to the default port to avoid confusion. 
    // https://developers.cloudflare.com/fundamentals/reference/network-ports/#network-ports-compatible-with-cloudflares-proxy
    const redirectTo = new URL(request.url);
    redirectTo.port = '';
    return new Response('Moved permanently to ' + redirectTo.href, {
      status: 301,
      headers: {
        location: redirectTo.href
      }
    });
  }

  if (url.pathname.startsWith('/drafts/')) {
    return new Response('Not Found', { status: 404 });
  }

  if(isRUMRequest(url)) {
    // only allow GET, POST, OPTIONS
    if(!['GET', 'POST', 'OPTIONS'].includes(request.method)) {
      return new Response('Method Not Allowed', { status: 405 });
    }
  }

  // media requests are only served if the hash was published (seen in a html/json/301 response)
  if (isMediaRequest(url) && env.PUBLISHED_MEDIA) {
    const hash = url.pathname.match(MEDIA_PATH_REGEX)[1];
    if (await env.PUBLISHED_MEDIA.get(hash) === null) {
      return new Response('Not Found', { status: 404 });
    }
  }

  const extension = getExtension(url.pathname);

  // remember original search params
  const savedSearch = url.search;

  // sanitize search params
  const { searchParams } = url;
  if (isMediaRequest(url)) {
    for (const [key] of searchParams.entries()) {
      if (!['format', 'height', 'optimize', 'width'].includes(key)) {
        searchParams.delete(key);
      }
    }
  } else if (extension === 'json') {
    for (const [key] of searchParams.entries()) {
      if (!['limit', 'offset', 'sheet'].includes(key)) {
        searchParams.delete(key);
      }
    }
  } else {
    // neither media nor json request: strip search params
    url.search = '';
  }
  searchParams.sort();
  
  url.hostname = env.ORIGIN_HOSTNAME;
  if (!url.origin.match(/^https:\/\/main--.*--.*\.aem\.live/)) {
    return new Response('Invalid ORIGIN_HOSTNAME', { status: 500 });
  }
  const req = new Request(url, request);
  req.headers.set('x-forwarded-host', req.headers.get('host'));
  req.headers.set('x-byo-cdn-type', 'cloudflare');
  if (env.PUSH_INVALIDATION !== 'disabled') {
    req.headers.set('x-push-invalidation', 'enabled');
  }
  if (env.ORIGIN_AUTHENTICATION) {
    req.headers.set('authorization', `token ${env.ORIGIN_AUTHENTICATION}`);
  }
  let resp = await fetch(req, {
    method: req.method,
    cf: {
      // cf doesn't cache html by default: need to override the default behavior
      cacheEverything: true,
    },
  });
  resp = new Response(resp.body, resp);
  if (resp.status === 301 && savedSearch) {
    const location = resp.headers.get('location');
    if (location && !location.match(/\?.*$/)) {
      resp.headers.set('location', `${location}${savedSearch}`);
    }
  }
  if (env.PUBLISHED_MEDIA && request.method === 'GET') {
    const hashes = [];
    if (resp.status === 301) {
      hashes.push(...extractMediaHashes(resp.headers.get('location')));
    } else if (resp.ok && resp.body) {
      const contentType = resp.headers.get('content-type') || '';
      if (/text\/html|json/i.test(contentType)) {
        const body = await resp.text();
        hashes.push(...extractMediaHashes(body));
        resp = new Response(body, resp);
      }
    }
    // block the response until all KV writes have completed
    try {
      await registerMediaHashes(env, hashes, url.pathname);
    } catch (e) {
      // serve the response anyway
      console.error('Failed to register media hashes', e);
    }
  }
  if (resp.status === 304) {
    // 304 Not Modified - remove CSP header
    resp.headers.delete('Content-Security-Policy');
  }
  resp.headers.delete('age');
  resp.headers.delete('x-robots-tag');
  return resp;
};

export default {
  fetch: handleRequest,
};
