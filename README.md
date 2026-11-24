# aem-cloudflare-prod-worker

A template for a Cloudflare worker which serves as a production CDN for an AEM project.

[`src/index.mjs`](https://github.com/adobe/aem-cloudflare-prod-worker/blob/main/src/index.mjs) is the content of the Workers script.

## 1. Setup Cloudflare production site

Follow the instructions [here](https://www.aem.live/docs/byo-cdn-cloudflare-setup).

## 2. Edit `wrangler.toml`

Update the following entries:

- `route` (route for your site, e.g. `*.mydomain.com/*`)
- `zone_id` (your Cloudflare Zone ID)
- `account_id` (your Cloudflare Account ID)
- `ORIGIN_HOSTNAME` (the hostname of your AEM project, e.g. `main--mysite--hlxsites.aem.live`)

To find your `account_id` and `zone_id` visit the [Websites Dashboard](https://dash.cloudflare.com/zones) in Cloudflare, select your site they will be listed on the right hand side of the dashboard under `API`.

## 3. Push invalidation

Configure [push invalidation](https://www.aem.live/docs/setup-byo-cdn-push-invalidation#cloudflare) for your project, as your worker will send the following header by default:

```
X-Push-Invalidation: enabled
```

If you need to opt-out of push-invalidation, you can set the `PUSH_INVALIDATION` environment variable in the Cloudflare dashboard to `disabled` or do the same via wrangler. Keep in mind that this will increase origin traffic and reduce performance so this should only be used on secondary lower environments.

## 4. Enable Origin Authentication (optional)

If you have enabled [Site Authentication](https://www.aem.live/docs/authentication-setup-site) for your project your worker should send the following header:

```
Authorization: token <token>
```

All you have to do is set the `ORIGIN_AUTHENTICATION` environment variable in the Cloudflare dashboard to the token you have configured in your AEM project or do the same via wrangler.

## 5. Inline navigation, footer, and fragments (optional)

Publish `/config.json` on the AEM origin with a `public.mixerConfig` object.
Each option is independent and disabled when omitted:

```json
{
  "public": {
    "mixerConfig": {
      "inlineNav": true,
      "inlineFooter": true,
      "inlineFragments": {
        "paths": ["/fragments/"]
      }
    }
  }
}
```

For HTML GET requests, the worker loads this file from `ORIGIN_HOSTNAME` through
Cloudflare's fetch cache, using its origin cache policy and the configured origin
authentication. A missing file disables inlining; other fetch errors or invalid
configuration return an uncacheable 502 rather than silently disabling it.

Navigation and footer are loaded from the page's `nav` and `footer` metadata and
inserted into empty `<header></header>` and `<footer></footer>` elements.
Each metadata value can contain multiple paths separated by commas, for example
`/nav/main, /nav/secondary` or `/footer/legal, /footer/links`. The resources
are inserted into the corresponding element in the order listed. Whitespace
around paths and empty entries are ignored.
Fragments are enabled by `inlineFragments`: links ending in `#inline` are
inlined, as are links whose path begins with one of its `paths` prefixes. Use
`"inlineFragments": {}` to enable only `#inline` links. The referenced resources
are fetched as `.plain.html` through the fetch cache. Inlining does not apply to
`.plain.html` requests.

The page and each inline are cached separately by fetch; the worker does not
merge their cache keys or store the assembled response in the fetch cache.
The response's `last-modified` is advanced to the most recent valid config or
inline date when the page itself has a valid date. Conditional requests are
evaluated against the assembled page; if config has no valid date or an inline
is skipped or has no valid date, the worker does not answer 304 based on that
date. A failed
inline is reported in `x-inline-error` and the incomplete response is marked
`private, no-store`.
Downstream caches can still cache the assembled response according to the page's
response headers; a purge of an inline does not invalidate those cached copies.

## 6. Deploy your site

Install `wrangler` (if you haven't done so already):

```sh
npm i -D wrangler@latest
```

Publish your site:

```sh
npx wrangler deploy
```

## 7. Test your site

Point your browser to your site (e.g. `https://www.mydomain.com/`).

For troubleshooting you can turn on logging in your terminal:

```sh
npx wrangler tail -f pretty
```
