terraform {
  required_version = ">= 1.4.0"
}

locals {
  app_name          = var.app_name
  environment_name = var.environment_name
  environment_type = var.environment_type
  cloud_provider   = var.cloud_provider
  region           = var.region
  domain           = var.domain
  public_ports     = var.public_ports
  ssh_allowed_cidrs = var.ssh_allowed_cidrs
  services = jsondecode(<<EOT
[
  {
    "name": "app",
    "type": "backend",
    "port": null,
    "source_path": ".",
    "health_check": "/health",
    "engine": null,
    "backup_enabled": false
  },
  {
    "name": "docker-sandbox",
    "type": "backend",
    "port": null,
    "source_path": "docker-sandbox",
    "health_check": "/health",
    "engine": null,
    "backup_enabled": false
  }
]
EOT
  )
}

resource "terraform_data" "application" {
  input = {
    app_name          = local.app_name
    environment_name  = local.environment_name
    environment_type  = local.environment_type
    cloud_provider    = local.cloud_provider
    region            = local.region
    domain            = local.domain
    public_ports      = local.public_ports
    ssh_allowed_cidrs = local.ssh_allowed_cidrs
  }
}

resource "terraform_data" "service" {
  for_each = { for service in local.services : service.name => service }

  input = {
    app_name    = local.app_name
    environment = local.environment_name
    service     = each.value
  }
}
