locals {
  access_bypass_paths = toset([
    "/.well-known/*",
    "/api/v1/internal/*",
    "/api/v1/webhooks/line",
    "/authorize",
    "/mcp",
    "/oauth/*",
  ])
}

resource "cloudflare_zero_trust_access_application" "wiki" {
  count = var.access_domain == null ? 0 : 1

  account_id                 = var.cloudflare_account_id
  name                       = "${local.name}-web"
  domain                     = var.access_domain
  type                       = "self_hosted"
  session_duration           = "24h"
  auto_redirect_to_identity  = true
  allowed_idps               = compact([var.access_google_identity_provider_id])
  app_launcher_visible       = false
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"
  options_preflight_bypass   = false

  policies = [{
    name       = "Allow workspace members"
    decision   = "allow"
    precedence = 1
    include = [for email in var.access_allowed_emails : {
      email = { email = email }
    }]
    require = [{
      login_method = { id = var.access_google_identity_provider_id }
    }]
  }]

  lifecycle {
    precondition {
      condition = (
        length(var.access_allowed_emails) > 0 &&
        var.access_google_identity_provider_id != null &&
        var.bootstrap_owner_email != null &&
        contains(
          [for email in var.access_allowed_emails : lower(trimspace(email))],
          try(lower(trimspace(var.bootstrap_owner_email)), ""),
        )
      )
      error_message = "access_allowed_emails, access_google_identity_provider_id, and an allowlisted bootstrap_owner_email are required when access_domain is set."
    }
  }
}

# Access protects the human-facing application. These paths perform their own
# OAuth, webhook-signature, or internal bridge authentication and must remain
# reachable by non-browser clients.
resource "cloudflare_zero_trust_access_application" "authenticated_bypass" {
  for_each = var.access_domain == null ? toset([]) : local.access_bypass_paths

  account_id                 = var.cloudflare_account_id
  name                       = "${local.name}-bypass-${substr(sha256(each.value), 0, 8)}"
  domain                     = "${var.access_domain}${each.value}"
  type                       = "self_hosted"
  app_launcher_visible       = false
  http_only_cookie_attribute = true

  policies = [{
    name       = "Bypass Access; endpoint verifies its own credentials"
    decision   = "bypass"
    precedence = 1
    include    = [{ everyone = {} }]
  }]
}
