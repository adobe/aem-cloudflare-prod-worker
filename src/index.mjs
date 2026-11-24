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

import inlineResources, { canInline } from './inlines.mjs';
import { ffetch, getTimeout, upstreamError } from './inline-support.mjs';

const getExtension = (path) => {
  const basename = path.split('/').pop();
  const pos = basename.lastIndexOf('.');
  return (basename === '' || pos < 1) ? '' : basename.slice(pos + 1);
};

const isMediaRequest = (url) => /\/media_[0-9a-f]{40,}[/a-zA-Z0-9_-]*\.[0-9a-z]+$/.test(url.pathname);
const isRUMRequest = (url) => /\/\.(rum|optel)\/.*/.test(url.pathname);

const isPageRequest = (request, url) => request.method === 'GET'
  && (!getExtension(url.pathname) || (url.pathname.endsWith('.html') && !url.pathname.endsWith('.plain.html')));

const loadMixerConfig = async (ctx, req, origin) => {
  const url = new URL('/config.json', origin);
  const headers = new Headers();
  for (const name of ['authorization', 'x-forwarded-host', 'x-byo-cdn-type', 'x-push-invalidation']) {
    if (req.headers.has(name)) headers.set(name, req.headers.get(name));
  }
  const timeout = getTimeout(ctx, 15000);
  const start = Date.now();
  try {
    if (!timeout) throw new Error('request deadline exceeded');
    return await ffetch(url, {
      headers,
      redirect: 'manual',
      cf: { cacheEverything: true },
    }, {
      timeout,
      read: async (response) => {
        if (response.status === 404) {
          await response.body?.cancel();
          return { config: {} };
        }
        if (!response.ok) throw new Error(`unexpected status ${response.status}`);
        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)
          || (data.public !== undefined
            && (!data.public || typeof data.public !== 'object' || Array.isArray(data.public)))) {
          throw new Error('invalid config document');
        }
        const config = data.public?.mixerConfig === undefined ? {} : data.public.mixerConfig;
        if (config === null || typeof config !== 'object' || Array.isArray(config)
          || (config.inlineNav !== undefined && typeof config.inlineNav !== 'boolean')
          || (config.inlineFooter !== undefined && typeof config.inlineFooter !== 'boolean')
          || (config.inlineFragments !== undefined
            && (typeof config.inlineFragments !== 'object' || config.inlineFragments === null
              || Array.isArray(config.inlineFragments)
              || (config.inlineFragments.paths !== undefined
                && (!Array.isArray(config.inlineFragments.paths)
                  || config.inlineFragments.paths.some((path) => typeof path !== 'string')))))) {
          throw new Error('invalid mixerConfig');
        }
        return { config, lastModified: response.headers.get('last-modified') };
      },
    });
  } catch (error) {
    throw upstreamError(ctx, { stage: 'config', host: url.host, error, timeout, start });
  }
};

const isNotModified = (request, response, ctx) => {
  const ims = request.headers.get('if-modified-since');
  if (response.status !== 200 || !ims || request.headers.has('if-none-match')
    || ctx.attributes.inlineDateUnknown) return false;
  const since = Date.parse(ims);
  return !Number.isNaN(since) && new Date(since).toUTCString() === ims
    && Date.parse(response.headers.get('last-modified')) <= since;
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
  const mixer = {
    config: { protocol: url.protocol.slice(0, -1), origin: url.host },
    deadline: Date.now() + 30000,
    requestId: request.headers.get('cf-ray') || '-',
    log: console,
    attributes: {},
    info: { method: request.method, headers: Object.fromEntries(req.headers) },
  };
  if (isPageRequest(request, url)) {
    try {
      const { config, lastModified } = await loadMixerConfig(mixer, req, url.origin);
      const { inlineNav, inlineFooter, inlineFragments } = config;
      Object.assign(mixer.config, { inlineNav, inlineFooter, inlineFragments });
      mixer.configLastModified = Date.parse(lastModified);
    } catch (error) {
      if (error.response) return error.response;
      throw error;
    }
  }
  const checkConditional = canInline(mixer, url);
  if (checkConditional) {
    if (Number.isNaN(mixer.configLastModified)) mixer.attributes.inlineDateUnknown = true;
    req.headers.delete('if-modified-since');
    req.headers.delete('if-none-match');
    req.headers.delete('if-range');
    req.headers.delete('range');
    req.headers.set('accept-encoding', 'gzip, deflate');
  }
  let resp = await fetch(req, {
    method: req.method,
    cf: {
      // cf doesn't cache html by default: need to override the default behavior
      cacheEverything: true,
    },
  });
  if (checkConditional) {
    try {
      resp = await inlineResources(mixer, url, resp);
    } catch (error) {
      if (error.response) return error.response;
      throw error;
    }
    if (isNotModified(request, resp, mixer)) {
      const headers = new Headers(resp.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      await resp.body?.cancel();
      resp = new Response(null, { status: 304, headers });
    }
  }
  resp = new Response(resp.body, resp);
  if (resp.status === 301 && savedSearch) {
    const location = resp.headers.get('location');
    if (location && !location.match(/\?.*$/)) {
      resp.headers.set('location', `${location}${savedSearch}`);
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
