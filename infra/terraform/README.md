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

Copy the resulting D1, KV, R2, Queue, AI Search, and AI Gateway identifiers into the target environment of `apps/worker/wrangler.jsonc`. Do not put secrets in Terraform state or committed Wrangler vars. Register these with `wrangler secret put`:

```text
ACCESS_AUDIENCE
ACCESS_ISSUER
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
TOKEN_ENCRYPTION_KEY
REALTIME_INTERNAL_SECRET
DISCORD_BOT_TOKEN
DISCORD_BRIDGE_SECRET
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
MCP_PUBLIC_ORIGIN
WORKER_INTERNAL_URL
```

Use a random 32-byte-or-longer value for `TOKEN_ENCRYPTION_KEY`, `REALTIME_INTERNAL_SECRET`, and `DISCORD_BRIDGE_SECRET`. Run D1 migrations before routing production traffic:

```powershell
npx wrangler d1 migrations apply nago-wiki-prod --remote --config apps/worker/wrangler.jsonc
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

The AI Search public search, chat-completions, and built-in MCP endpoints are disabled. Access is only through the Worker, where current D1 ACL and content hashes are rechecked.
