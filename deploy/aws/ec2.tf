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

  # An ephemeral public IP at launch, distinct from the Elastic IP associated
  # right after (aws_eip_association below) — needed so the instance can
  # reach the internet immediately: dnf, the Node/Caddy downloads, git clone,
  # and SSM agent registration all happen in user_data, before the EIP
  # association completes.
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
    hostname      = "${aws_eip.teamshare.public_ip}.sslip.io"
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

# Caddy on this box requests a Let's Encrypt certificate for
# <elastic-ip>.sslip.io on its own, retrying automatically — no custom wait
# loop needed. It starts succeeding once this association completes and the
# hostname actually resolves to a reachable instance.
resource "aws_eip_association" "teamshare" {
  instance_id   = aws_instance.teamshare.id
  allocation_id = aws_eip.teamshare.id
}
