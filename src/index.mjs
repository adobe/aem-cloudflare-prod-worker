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

// Closed User Group (CUG) headers sent by the AEM Edge Delivery origin when a
// resource is protected. These are an origin <-> worker contract and must
// NEVER be forwarded to the browser (see the strip step below).
//
//   x-aem-cug-required: "true" when the resource is part of a closed user group
//   x-aem-cug-groups:   comma-separated list of group identifiers allowed access
const CUG_REQUIRED_HEADER = 'x-aem-cug-required';
const CUG_GROUPS_HEADER = 'x-aem-cug-groups';

/**
 * Authorization hook for Closed User Group (CUG) protected resources.
 *
 * --------------------------------------------------------------------------
 * AUTHENTICATION IS NOT INCLUDED IN THIS TEMPLATE.
 * --------------------------------------------------------------------------
 *
 * Wire your identity provider in here. A typical implementation would:
 *   1. Read a signed session cookie / JWT from `request`.
 *   2. If missing or invalid, redirect to your IdP (Adobe IMS, Okta, Auth0,
 *      Azure AD, ...) using OAuth 2.0 Authorization Code + PKCE.
 *   3. On callback, create a signed session and set it as an
 *      HttpOnly; Secure; SameSite=Lax cookie.
 *   4. Match the user's claims (e.g. email domain, groups) against
 *      `allowedGroups` (parsed from x-aem-cug-groups) and return true/false.
 *
 * Reference implementation (Adobe IMS + JWT session + Cloudflare KV):
 *   https://github.com/aemsites/summit-portal/tree/main/workers/cloudflare/cug-adobe-oauth-worker
 *
 * Until this is implemented, CUG-protected resources return 401 Unauthorized
 * — that is the secure default. Never return `true` unconditionally from this
 * function in production.
 *
 * @param {Request} request       the incoming request (use to read cookies)
 * @param {object}  env           Worker environment (vars, secrets, KV, ...)
 * @param {string[]} allowedGroups groups allowed by the origin, may be empty
 * @returns {Promise<boolean>}    true to serve the response, false to deny
 */
// eslint-disable-next-line no-unused-vars
async function isAuthorized(request, env, allowedGroups) {
  return false;
}

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
  if (!url.origin.match(/^https:\/\/main--.*--.*\.(?:aem|hlx)\.live/)) {
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

  // --- Closed User Group (CUG) enforcement ---
  // Read CUG signals from the origin response, then strip them so they never
  // leak to the browser. If the resource is CUG-protected, delegate the
  // decision to the `isAuthorized` hook above (which the customer implements
  // against their identity provider).
  const cugRequired = resp.headers.get(CUG_REQUIRED_HEADER) === 'true';
  const cugGroupsHeader = resp.headers.get(CUG_GROUPS_HEADER) || '';
  resp.headers.delete(CUG_REQUIRED_HEADER);
  resp.headers.delete(CUG_GROUPS_HEADER);

  if (cugRequired) {
    const allowedGroups = cugGroupsHeader
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
    const ok = await isAuthorized(request, env, allowedGroups);
    if (!ok) {
      // Secure default: deny when auth is not implemented or the user is not
      // authorized. Replace this with a redirect to your IdP in `isAuthorized`.
      return new Response('Unauthorized', { status: 401 });
    }
    // Authenticated CUG responses are user-specific: prevent caching by the
    // browser. The AEM origin is expected to also send Cache-Control: private
    // on CUG resources so the CF edge cache does not retain them.
    resp.headers.set('Cache-Control', 'private, no-store');
  }

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
