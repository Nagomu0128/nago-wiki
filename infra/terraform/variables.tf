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
