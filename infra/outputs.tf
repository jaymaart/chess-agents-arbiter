output "environment" {
  value = {
    app_name     = var.app_name
    environment  = var.environment_name
    type         = var.environment_type
    cloud        = var.cloud_provider
    region       = var.region
    domain       = var.domain
  }
}

output "service_names" {
  value = keys(terraform_data.service)
}
