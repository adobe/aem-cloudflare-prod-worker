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

## 5. Deploy your site

Install `wrangler` (if you haven't done so already):

```sh
npm i -D wrangler@latest
```

Publish your site:

```sh
npx wrangler deploy
```

## 5. Test your site

Point your browser to your site (e.g. `https://www.mydomain.com/`).

For troubleshooting you can turn on logging in your terminal:

```sh
npx wrangler tail -f pretty
```
