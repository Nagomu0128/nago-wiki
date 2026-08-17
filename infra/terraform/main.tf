locals {
  name = "nago-wiki-${var.environment}"
}

resource "cloudflare_d1_database" "wiki" {
  account_id            = var.cloudflare_account_id
  name                  = local.name
  primary_location_hint = var.d1_primary_location
}

resource "cloudflare_r2_bucket" "files" {
  account_id    = var.cloudflare_account_id
  name          = "${local.name}-files"
  location      = "apac"
  storage_class = "Standard"
}

resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.cloudflare_account_id
  title      = "${local.name}-oauth"
}

resource "cloudflare_queue" "dead_letter" {
  account_id = var.cloudflare_account_id
  queue_name = "${local.name}-jobs-dlq"
  settings = {
    message_retention_period = 1209600
  }
}

resource "cloudflare_queue" "jobs" {
  account_id = var.cloudflare_account_id
  queue_name = "${local.name}-jobs"
  settings = {
    message_retention_period = 345600
  }
}

resource "cloudflare_ai_gateway" "wiki" {
  account_id                 = var.cloudflare_account_id
  id                         = local.name
  cache_invalidate_on_update = true
  cache_ttl                  = 0
  collect_logs               = false
  log_management             = 10000
  log_management_strategy    = "STOP_INSERTING"
  rate_limiting_interval     = 60
  rate_limiting_limit        = 120
  rate_limiting_technique    = "fixed"
}

resource "cloudflare_ai_search_instance" "wiki" {
  account_id      = var.cloudflare_account_id
  id              = local.name
  ai_gateway_id   = cloudflare_ai_gateway.wiki.id
  embedding_model = "@cf/baai/bge-m3"
  reranking       = true
  reranking_model = "@cf/baai/bge-reranker-base"
  fusion_method   = "rrf"
  chunk           = true
  chunk_size      = 800
  chunk_overlap   = 15
  max_num_results = 50
  index_method = {
    keyword = true
    vector  = true
  }
  custom_metadata = [
    { field_name = "workspace_id", data_type = "text" },
    { field_name = "page_id", data_type = "text" },
    { field_name = "content_hash", data_type = "text" },
    { field_name = "language", data_type = "text" },
    { field_name = "kind", data_type = "text" },
  ]
  public_endpoint_params = {
    enabled = false
    chat_completions_endpoint = {
      disabled = true
    }
    mcp = {
      disabled    = true
      description = "Disabled: use the ACL-aware Nago Wiki MCP endpoint."
    }
    search_endpoint = {
      disabled = true
    }
  }
}

resource "cloudflare_worker" "wiki" {
  account_id = var.cloudflare_account_id
  name       = local.name
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 0.1
      persist            = true
    }
  }
  subdomain = {
    enabled          = true
    previews_enabled = var.environment != "prod"
  }
  tags = ["nago-wiki", var.environment]
}
