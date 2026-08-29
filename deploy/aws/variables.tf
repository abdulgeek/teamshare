variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type. teamshare stores all team state in one SQLite file that
    requires exactly one writer on a real local disk (its own spec warns WAL
    misbehaves on network filesystems). This must stay a single always-on
    instance — do not turn this into an Auto Scaling Group or anything with
    more than one instance; that would corrupt the database.
  EOT
  type        = string
  default     = "t4g.small"
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size in GiB (gp3, encrypted)."
  type        = number
  default     = 20
}

variable "repo_url" {
  description = "Git URL of the teamshare repository, cloned onto the instance at first boot."
  type        = string
  default     = "https://github.com/abdulgeek/teamshare"
}

variable "node_version" {
  description = <<-EOT
    Pinned Node.js version (teamshare requires >= 20). Downloaded directly from
    nodejs.org as a tarball — never `dnf install nodejs`, which drifts with the
    distro and does not guarantee >= 20.
  EOT
  type        = string
  default     = "20.20.2"
}

variable "pnpm_version" {
  description = "Pinned pnpm version activated via corepack. Matched to this repo's pnpm-lock.yaml (lockfileVersion 9.0)."
  type        = string
  default     = "9.15.4"
}

variable "caddy_version" {
  description = "Pinned Caddy release version (no leading v), downloaded directly from the official GitHub release — no third-party dnf repo."
  type        = string
  default     = "2.11.4"
}

variable "ami_ssm_parameter" {
  description = <<-EOT
    SSM public parameter resolving the AL2023 arm64 AMI.

    DECISION TO CHECK: the task brief specified
    /aws/service/ami-al2023/ami-al2023-kernel-default-arm64. That path was
    verified against this account/region and does not exist — AWS returns
    "aws/service/ami-al2023 is not a valid namespace" (confirmed not a
    permissions issue: a sibling public parameter one level up,
    /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64,
    resolves fine and was verified live to ami-0cded71ff6ab7f608). That
    verified path is used here instead so `terraform plan` doesn't fail on
    day one. Please confirm this substitution is acceptable.
  EOT
  type        = string
  default     = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

variable "vpc_cidr" {
  description = <<-EOT
    CIDR for a dedicated teamshare VPC.

    DECISION TO CHECK: this account has no default VPC in us-east-1 (verified
    live: `aws ec2 describe-vpcs --filters Name=isDefault,Values=true` returns
    none). Two other, non-default VPCs exist (10.20.0.0/16, 10.0.0.0/16) but
    the brief gave no guidance on which — if either — teamshare should share,
    and guessing wrong could land the instance in a private subnet with no
    route to the internet. This stack therefore provisions its own small,
    self-contained public VPC/subnet/IGW instead of assuming one of the
    existing ones. Please confirm, or point this at an existing VPC/subnet.
  EOT
  type        = string
  default     = "10.42.0.0/24"
}

variable "availability_zone" {
  description = "Availability zone for the single public subnet."
  type        = string
  default     = "us-east-1a"
}

variable "use_elastic_ip" {
  description = <<-EOT
    Attach a stable Elastic IP to the instance.

    Now TRUE by default. It was false for the very first deployment because
    the account was at its EIP quota; an increase to 15 was approved on
    2026-08-29 and the address is attached. Without it, a stop/start assigns a
    new public IP, which changes the <ip>.sslip.io hostname and forces every
    teammate to reconnect — the server heals itself (see
    files/teamshare-hostname.sh) but clients cannot.

    Setting this back to false would release the address and reintroduce that
    fragility.
  EOT
  type        = bool
  default     = true
}
