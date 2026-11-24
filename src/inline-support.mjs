/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

export const BACKEND_FETCH_TIMEOUT = 30000;
export const INLINE_FETCH_TIMEOUT = 15000;
export const NO_STORE_HEADERS = { 'cache-control': 'private, no-store' };

export class FetchTimeoutError extends Error {
  constructor(timeout) {
    super(`fetch timeout after ${timeout}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export async function withTimeout(promise, timeout, onTimeout) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new FetchTimeoutError(timeout);
      reject(error);
      onTimeout?.(error);
    }, timeout);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function ffetch(url, init, { timeout, read }) {
  const controller = new AbortController();
  const pending = fetch(url, { ...init, signal: controller.signal });
  return withTimeout(
    read ? pending.then(read) : pending,
    timeout,
    (error) => controller.abort(error),
  );
}

export function getTimeout(ctx, timeout) {
  return Math.max(0, Math.min(timeout, ctx.deadline - Date.now()));
}

export function toHeaderValue(message) {
  return String(message).replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 256);
}

export function upstreamError(ctx, { stage, host, error, timeout, start }) {
  const message = error instanceof FetchTimeoutError
    ? `${stage} fetch timeout (${host}) after ${timeout}ms`
    : `${stage} fetch error (${host}): ${error.message}`;
  ctx.log.error(`${message} (elapsed=${Date.now() - start}ms, request=${ctx.requestId})`);
  const wrapped = new Error(message);
  wrapped.response = new Response('', {
    status: 502,
    headers: { ...NO_STORE_HEADERS, 'x-error': toHeaderValue(message) },
  });
  return wrapped;
}
