variable "cloudflare_account_id" {
  description = "Cloudflare account identifier."
  type        = string
  sensitive   = true
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
