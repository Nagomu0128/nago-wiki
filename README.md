# Nago Wiki

Cloudflare上で動く、Markdownを正本としたprivate knowledge wikiです。設計の正本は[Design Document](./doc/design%20doc.md)を参照してください。

## Workspace

- `apps/worker`: Hono API、Durable Objects、MCP、Queues/Workflows
- `apps/web`: React + ViteのWiki UI
- `apps/discord-bot`: Discord Gateway用Cloudflare Container application
- `packages/shared`: API schemaと共有domain type
- `migrations`: D1 migration

## Local commands

```bash
npm install
npm run check
npm run dev
```

`npm run dev` starts the API Worker and Vite together; the Vite proxy forwards
both HTTP API calls and realtime WebSocket upgrades. Production uses
`npm run deploy:production` to build and upload the Web SPA with the Worker.

Cloudflare resource IDやOAuth secretはrepositoryへ保存しません。local secretは`.dev.vars`、production secretはWrangler SecretsまたはSecrets Storeを使用します。

## Provisioning

Cloudflare account-level resources are managed under [`infra/terraform`](./infra/terraform). The Worker, Durable Objects, Workflows, Queue consumer, and Discord Container are deployed from [`apps/worker/wrangler.jsonc`](./apps/worker/wrangler.jsonc). See the infrastructure README for the provisioning order and required secrets.
