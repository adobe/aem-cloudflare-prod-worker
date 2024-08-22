# helix-cloudflare-prod-worker-template

A template for a Cloudflare worker which serves as a production CDN for an AEM project.

[`src/index.mjs`](https://github.com/adobe/helix-cloudflare-prod-worker-template/blob/main/src/index.mjs) is the content of the Workers script.

## 1. Setup Cloudflare production site

Follow the instructions [here](https://www.aem.live/docs/byo-cdn-cloudflare-setup).

## 2. Edit `wrangler.toml`

Update the following entries:

- `route` (route for your site, e.g. `*.mydomain.com/*`)
- `zone_id` (your Cloudflare Zone ID)
- `account_id` (your Cloudflare Account ID)
- `ORIGIN_HOSTNAME` (the hostname of your AEM project, e.g. `main--mysite--hlxsites.aem.live`)

You can find your `account_id` and `zone_id` in the right sidebar of your site's overview tab at https://dash.cloudflare.com (you may have to scroll down).

## 3. Configure push invalidation (optional)

If you have succesfully configured [push invalidation](https://www.aem.live/docs/setup-byo-cdn-push-invalidation#cloudflare) for your project your worker should send the following opt-in header:

```
X-Push-Invalidation: enabled
```

All you have to do is set the `PUSH_INVALIDATION` environment variable in the Cloudflare dashboard to `enabled` or do the same via wrangler.

## 4. Publish your site

Install `wrangler` (if you haven't done so already):

```sh
npm i @cloudflare/wrangler -g
```

Publish your site:

```sh
wrangler publish
```

## 5. Test your site

Point your browser to your site (e.g. `https://www.mydomain.com/`).

For troubleshooting you can turn on logging in your terminal:

```sh
wrangler tail -f pretty
```
