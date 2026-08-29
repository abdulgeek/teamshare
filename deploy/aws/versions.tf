# Local state on purpose: the team's existing Terraform (p3m-terraform-state-prod /
# -qa in S3) is left untouched. This is a separate, self-contained stack.
terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Every resource this stack creates that supports tagging gets these three
  # tags automatically — "tag every resource" from the brief, enforced once
  # here instead of repeated on each resource.
  default_tags {
    tags = {
      Name      = "teamshare"
      Project   = "teamshare"
      ManagedBy = "terraform"
    }
  }
}
