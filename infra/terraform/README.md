# Cloudflare infrastructure

Terraform creates the durable account-level resources. Wrangler deploys the Worker code, Workflows, Durable Object migrations, Queue consumer, and Container after these resources exist.

```powershell
$env:CLOUDFLARE_API_TOKEN = "replace-with-a-scoped-token"
Copy-Item terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -out nago-wiki.tfplan
terraform apply nago-wiki.tfplan
terraform output
```

To manage Cloudflare Access in the same state, set `access_domain`,
`access_allowed_emails`, `bootstrap_owner_email`, and
`access_google_identity_provider_id`. The bootstrap address must also be in the
Access allowlist. The root Web
application is restricted to the exact email allowlist and Google IdP. MCP/OAuth,
the LINE webhook, and Discord bridge paths receive narrower Access bypass
applications because those endpoints enforce bearer tokens or request signatures.
Copy the `access_application_audience` output into the production
`ACCESS_AUDIENCE` Worker variable. Copy `bootstrap_owner_email` into the
`BOOTSTRAP_OWNER_EMAIL` Worker variable; the first verified Access identity with
that address becomes the initial Owner. Once an active Owner exists, this setting
does not replace it.

Copy the resulting D1, KV, R2, Queue, AI Search, and AI Gateway identifiers into the `production` environment of `apps/worker/wrangler.jsonc`; the all-zero IDs and `owner@configure-before-deploy.invalid` are intentional non-deployable placeholders. Set `ACCESS_AUDIENCE`, `ACCESS_ISSUER`, `GOOGLE_CLIENT_ID`, `MCP_PUBLIC_ORIGIN`, `WORKER_INTERNAL_URL`, `WORKSPACE_ID`, `BOOTSTRAP_OWNER_EMAIL`, and `ALLOW_DEVELOPMENT_IDENTITY=false` as non-secret production vars. Do not put secrets in Terraform state or committed Wrangler vars. Register only these values with `wrangler secret put --env production`:

```text
GOOGLE_CLIENT_SECRET
TOKEN_ENCRYPTION_KEY
REALTIME_INTERNAL_SECRET
DISCORD_BOT_TOKEN
DISCORD_BRIDGE_SECRET
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
```

Use a random 32-byte-or-longer value for `TOKEN_ENCRYPTION_KEY`, `REALTIME_INTERNAL_SECRET`, and `DISCORD_BRIDGE_SECRET`. Run D1 migrations before routing production traffic:

```powershell
npx wrangler d1 migrations apply nago-wiki-prod --remote --env production --config apps/worker/wrangler.jsonc
npm run deploy:production
```

The production deploy command builds the React SPA first, then uploads it with
the Worker as Cloudflare Static Assets. API, realtime, OAuth, and MCP paths run
the Worker first; all other navigation paths use the SPA fallback.

The AI Search public search, chat-completions, and built-in MCP endpoints are disabled. Access is only through the Worker, where current D1 ACL and content hashes are rechecked.
