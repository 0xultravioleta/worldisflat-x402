# Flat Fee on AWS Lightsail Containers (us-east-2): one nano container behind Lightsail's HTTPS endpoint.
# Plan only: c0der applies it with the DAO account. Turn it off after the final closes (Mon 16 Nov 2026, 17:30 UTC):
#   terraform destroy        (or: aws lightsail delete-container-service --service-name flatfee --region us-east-2)
# Every apply that changes the container's environment redeploys it, and the new container starts with an empty DATA_DIR.
# Cost: nano = 7 USD / month, billed by the hour.
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-2"
}

variable "service_name" {
  type    = string
  default = "flatfee"
}

# the image pushed with `aws lightsail push-container-image` (see README "Deploy"), e.g. ":flatfee.web.1"
variable "image" {
  type = string
}

variable "network" {
  type    = string
  default = "robinhood"
}

variable "pay_to" {
  type = string
}

variable "public_url" {
  type    = string
  default = ""
}

variable "wif_cashback" {
  type    = string
  default = "10"
}

variable "wif_worker_reward" {
  type    = string
  default = "50"
}

variable "wif_daily_budget" {
  type    = string
  default = "500"
}

# The key ends up in plain text in terraform.tfvars (gitignored), in the Terraform state, and in the container's
# environment, which anyone with Lightsail access in the account can read: the merchant wallet must only ever hold the
# $WIF cashback budget and a little gas, never more.
variable "merchant_private_key" {
  type      = string
  sensitive = true
}

# The private RPC the server reads and sends through (RPC_URL): required, there is no default and no public RPC is
# used. It can carry an API key, so it is kept like the merchant key.
variable "rpc_url" {
  type      = string
  sensitive = true
  validation {
    condition     = length(trimspace(var.rpc_url)) > 0
    error_message = "rpc_url is required: the private RPC of the network (the server refuses to start without RPC_URL)."
  }
}

# WIF_WORKER_REWARD needs it, or the container refuses to start; it also gates the task board
variable "worker_token" {
  type      = string
  sensitive = true
  validation {
    condition     = length(var.worker_token) >= 16
    error_message = "worker_token must be at least 16 characters (e.g. openssl rand -hex 16): hiring and the worker reward need it."
  }
}

# Hiring through Execution Market (docs/EXECUTION-MARKET.md): off by default; empty values keep the app's defaults.
# On, the merchant wallet above also pays a USDG escrow per hire, so it holds USDG for the bounties too.
variable "em_hire" {
  type    = string
  default = "off"
}

variable "em_api_url" {
  type    = string
  default = ""
}

variable "em_bounty_usdg" {
  type    = string
  default = ""
}

variable "em_escrow_address" {
  type    = string
  default = ""
}

variable "em_operator_address" {
  type    = string
  default = ""
}

variable "em_token_collector_address" {
  type    = string
  default = ""
}

variable "em_reputation_network" {
  type    = string
  default = ""
}

variable "em_payment_token" {
  type    = string
  default = ""
}

variable "em_deadline_hours" {
  type    = string
  default = ""
}

variable "em_poll_seconds" {
  type    = string
  default = ""
}

resource "aws_lightsail_container_service" "flatfee" {
  name        = var.service_name
  power       = "nano"
  scale       = 1
  is_disabled = false
  tags = {
    project = "worldisflat-x402"
    expires = "2026-11-16T17:30Z"
  }

  # The custom domain (flatfee.ultravioletadao.xyz) and its certificate are attached outside terraform: without this,
  # an apply would detach them from the service.
  lifecycle {
    ignore_changes = [public_domain_names]
  }
}

resource "aws_lightsail_container_service_deployment_version" "flatfee" {
  service_name = aws_lightsail_container_service.flatfee.name

  container {
    container_name = "web"
    image          = var.image
    command        = []
    environment = {
      NETWORK                    = var.network
      RPC_URL                    = var.rpc_url
      PAY_TO                     = var.pay_to
      PUBLIC_URL                 = var.public_url
      WIF_CASHBACK               = var.wif_cashback
      WIF_WORKER_REWARD          = var.wif_worker_reward
      WIF_DAILY_BUDGET           = var.wif_daily_budget
      MERCHANT_PRIVATE_KEY       = var.merchant_private_key
      WORKER_TOKEN               = var.worker_token
      PORT                       = "3000"
      EM_HIRE                    = var.em_hire
      EM_API_URL                 = var.em_api_url
      EM_BOUNTY_USDG             = var.em_bounty_usdg
      EM_ESCROW_ADDRESS          = var.em_escrow_address
      EM_OPERATOR_ADDRESS        = var.em_operator_address
      EM_TOKEN_COLLECTOR_ADDRESS = var.em_token_collector_address
      EM_REPUTATION_NETWORK      = var.em_reputation_network
      EM_PAYMENT_TOKEN           = var.em_payment_token
      EM_DEADLINE_HOURS          = var.em_deadline_hours
      EM_POLL_SECONDS            = var.em_poll_seconds
    }
    ports = {
      "3000" = "HTTP"
    }
  }

  public_endpoint {
    container_name = "web"
    container_port = 3000
    health_check {
      path                = "/health"
      success_codes       = "200"
      healthy_threshold   = 2
      unhealthy_threshold = 2
      timeout_seconds     = 5
      interval_seconds    = 30
    }
  }
}

output "url" {
  value = aws_lightsail_container_service.flatfee.url
}
