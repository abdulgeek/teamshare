# Resolved dynamically, never hardcoded — see variables.tf (ami_ssm_parameter)
# for why this path differs from the one in the original brief.
data "aws_ssm_parameter" "al2023_arm64" {
  name = var.ami_ssm_parameter
}

resource "aws_instance" "teamshare" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.teamshare.id
  vpc_security_group_ids = [aws_security_group.teamshare.id]
  iam_instance_profile   = aws_iam_instance_profile.teamshare.name

  # The instance's auto-assigned public IP is what teammates reach and what the
  # TLS hostname is derived from (<ip>.sslip.io, computed at boot from IMDS).
  # No Elastic IP: this account is at its EIP quota, with every address in use
  # by other p3m infrastructure. Trade-off documented in README.md — stopping
  # and starting the instance changes this IP, and therefore the URL.
  associate_public_ip_address = true

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  # No SSH key is configured anywhere in this stack: administration is via
  # SSM Session Manager only (see security_group.tf — port 22 is
  # intentionally never opened, and iam.tf grants AmazonSSMManagedInstanceCore).
  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    repo_url      = var.repo_url
    node_version  = var.node_version
    pnpm_version  = var.pnpm_version
    caddy_version = var.caddy_version
  })

  # This is a single stateful instance holding the only copy of the database,
  # so a user_data change replacing the instance is a deliberate, visible-in-
  # plan event, not a silent in-place mutation of a running box.
  user_data_replace_on_change = true
}

# Caddy requests a Let's Encrypt certificate for <public-ip>.sslip.io on its
# own and retries automatically, so no wait loop is needed here — issuance
# succeeds as soon as the instance is reachable on port 80.
