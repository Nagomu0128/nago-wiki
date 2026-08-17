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

Cloudflare resource IDやOAuth secretはrepositoryへ保存しません。local secretは`.dev.vars`、production secretはWrangler SecretsまたはSecrets Storeを使用します。
