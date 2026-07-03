variable "app_name" {
  description = "Application name from the generated infrastructure spec."
  type        = string
}

variable "environment_name" {
  description = "Deployment environment name."
  type        = string
}

variable "environment_type" {
  description = "Deployment environment type, such as staging or production."
  type        = string
}

variable "cloud_provider" {
  description = "Target cloud provider."
  type        = string
}

variable "region" {
  description = "Target cloud region."
  type        = string
}

variable "domain" {
  description = "Public domain for this environment."
  type        = string
}

variable "public_ports" {
  description = "Public ports expected to be reachable."
  type        = list(number)
  default     = []
}

variable "ssh_allowed_cidrs" {
  description = "CIDR ranges allowed to access SSH. Keep this narrow."
  type        = list(string)
  default     = []
}
