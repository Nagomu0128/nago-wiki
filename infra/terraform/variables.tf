variable "cloudflare_account_id" {
  description = "Cloudflare account identifier."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone containing access_domain. Required when access_domain is set."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.cloudflare_zone_id == null ||
      can(regex("^[0-9a-fA-F]{32}$", var.cloudflare_zone_id))
    )
    error_message = "cloudflare_zone_id must be a 32-character hexadecimal zone ID."
  }
}

variable "environment" {
  description = "Resource suffix, for example dev or prod."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must contain lowercase letters, digits, and hyphens only."
  }
}

variable "d1_primary_location" {
  description = "D1 primary location hint. apac keeps the primary close to Japan."
  type        = string
  default     = "apac"
}

variable "access_domain" {
  description = "Hostname protected by Cloudflare Access, without a URL scheme. Null skips Access creation."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.access_domain == null ||
      can(regex("^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", var.access_domain))
    )
    error_message = "access_domain must be a lowercase hostname without a scheme or path."
  }
}

variable "access_allowed_emails" {
  description = "Exact verified email addresses allowed into the private wiki."
  type        = set(string)
  default     = []
  sensitive   = true

  validation {
    condition = alltrue([
      for email in var.access_allowed_emails :
      can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))
    ])
    error_message = "Every access_allowed_emails value must be an email address."
  }
}

variable "access_google_identity_provider_id" {
  description = "Cloudflare Access Google identity provider UUID."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.access_google_identity_provider_id == null ||
      can(regex("^[0-9a-fA-F-]{32,36}$", var.access_google_identity_provider_id))
    )
    error_message = "access_google_identity_provider_id must be a Cloudflare Access IdP UUID."
  }
}

variable "ai_monthly_budget_usd" {
  description = "Monthly workspace-wide AI Gateway spend limit in USD."
  type        = number
  default     = 2

  validation {
    condition     = var.ai_monthly_budget_usd > 0
    error_message = "ai_monthly_budget_usd must be positive."
  }
}

variable "ai_user_monthly_budget_usd" {
  description = "Monthly AI Gateway spend limit per user_id metadata value in USD."
  type        = number
  default     = 1.5

  validation {
    condition     = var.ai_user_monthly_budget_usd > 0 && var.ai_user_monthly_budget_usd <= var.ai_monthly_budget_usd
    error_message = "ai_user_monthly_budget_usd must be positive and no greater than the workspace budget."
  }
}
