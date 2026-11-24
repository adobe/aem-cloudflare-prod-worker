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

/**
 * Decompresses a Response based on its content-encoding header.
 * Supports gzip and deflate compression.
 * Returns the original response if not compressed or encoding is not supported.
 *
 * Note: Brotli is intentionally not supported to prevent cache poisoning issues.
 * The handler forces accept-encoding to 'gzip, deflate' to prevent brotli responses.
 *
 * @param {Response} response - The potentially compressed response
 * @param {object} ctx - Context object with logging
 * @returns {Promise<Response>} - Decompressed response with content-encoding header removed
 */
export async function decompressResponse(response, ctx) {
  const contentEncoding = response.headers.get('content-encoding');

  if (!contentEncoding || contentEncoding === 'identity') {
    // No compression or explicit identity encoding
    return response;
  }

  try {
    let decompressedStream;

    if (contentEncoding === 'gzip') {
      // Use DecompressionStream for gzip
      decompressedStream = response.body.pipeThrough(new DecompressionStream('gzip'));
      ctx.log.debug('Decompressing gzip response');
    } else if (contentEncoding === 'deflate') {
      // Use DecompressionStream for deflate
      decompressedStream = response.body.pipeThrough(new DecompressionStream('deflate'));
      ctx.log.debug('Decompressing deflate response');
    } else {
      // Unknown encoding, return as-is
      ctx.log.warn(`Unknown content-encoding: ${contentEncoding}, returning compressed response`);
      return response;
    }

    // For gzip/deflate, create new response with decompressed stream
    if (decompressedStream) {
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length'); // Length will change after decompression

      return new Response(decompressedStream, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  } catch (error) {
    ctx.log.error(`Failed to decompress ${contentEncoding} response:`, error);
    // If decompression fails, return the original response
    // This allows the request to continue even if decompression isn't supported
  }

  return response;
}

/**
 * Read text from a potentially compressed response. Reads the body as an
 * ArrayBuffer and inspects magic bytes to decide whether decompression is
 * actually needed — some runtimes (Cloudflare Workers) transparently
 * decompress the body but leave the content-encoding header, causing
 * DecompressionStream to fail on already-plain bytes.
 *
 * @param {Response} response - The potentially compressed response
 * @param {object} ctx - Context object with logging
 * @returns {Promise<string>} - The decompressed text content
 */
export async function readResponseText(response, ctx) {
  const contentEncoding = response.headers.get('content-encoding');
  if (!contentEncoding || contentEncoding === 'identity') {
    return response.text();
  }
  if (contentEncoding !== 'gzip' && contentEncoding !== 'deflate') {
    throw new Error(`unsupported content-encoding: ${contentEncoding}`);
  }

  const buf = await response.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const isGzip = contentEncoding === 'gzip'
    && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const isDeflate = contentEncoding === 'deflate'
    && bytes.length >= 1 && bytes[0] === 0x78;

  if (isGzip || isDeflate) {
    const format = isGzip ? 'gzip' : 'deflate';
    ctx.log.debug(`Decompressing ${format} response body`);
    const stream = new Response(bytes).body.pipeThrough(
      new DecompressionStream(format),
    );
    return new Response(stream).text();
  }

  ctx.log.debug('Response body already decompressed despite content-encoding header');
  return new TextDecoder().decode(bytes);
}
