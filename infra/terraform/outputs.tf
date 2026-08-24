output "d1_database_id" {
  value = cloudflare_d1_database.wiki.id
}

output "r2_bucket_name" {
  value = cloudflare_r2_bucket.files.name
}

output "oauth_kv_namespace_id" {
  value = cloudflare_workers_kv_namespace.oauth.id
}

output "jobs_queue_name" {
  value = cloudflare_queue.jobs.queue_name
}

output "dead_letter_queue_name" {
  value = cloudflare_queue.dead_letter.queue_name
}

output "ai_search_instance_name" {
  value = cloudflare_ai_search_instance.wiki.id
}

output "ai_gateway_id" {
  value = cloudflare_ai_gateway.wiki.id
}

output "access_application_audience" {
  description = "Copy this value to ACCESS_AUDIENCE after Access is enabled."
  value       = try(cloudflare_zero_trust_access_application.wiki[0].aud, null)
}

output "worker_custom_hostname" {
  description = "Production hostname routed to the Worker and protected by Access."
  value       = try(cloudflare_workers_custom_domain.wiki[0].hostname, null)
}
