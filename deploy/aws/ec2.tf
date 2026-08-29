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
    # Threaded straight into the teamshare.service unit's Environment= line
    # (user_data.sh.tpl) so `serve` picks it up as TEAMSHARE_SIGNUP_SECRET on
    # every boot — see variables.tf (signup_secret) for why this replaces
    # handing out per-team tokens via SSM. Left as an empty string when the
    # variable is null: cli.ts treats an empty value the same as unset and
    # falls back to generating one on first boot, so this is never a syntax
    # hazard, just a documented no-op.
    # NOT coalesce(): it rejects empty strings as well as null, so
    # coalesce(var.signup_secret, "") throws "no non-null, non-empty-string
    # arguments" whenever the variable is unset — which is the default case,
    # and broke every plan.
    signup_secret = var.signup_secret == null ? "" : var.signup_secret
    # Base64, not raw text: this goes through templatefile()'s own ${...}
    # interpolation, and the backup script uses plenty of shell $-syntax of
    # its own. Base64 has no `$` or `{` in it, so there is nothing for
    # Terraform to (mis)interpolate — the bytes that land in user_data are
    # guaranteed identical to deploy/aws/files/teamshare-backup.sh, the one
    # source of truth also shipped standalone via SSM (see that file and
    # deploy/aws/README.md).
  })

  # This is a single stateful instance holding the only copy of the database,
  # so a user_data change replacing the instance is a deliberate, visible-in-
  # plan event, not a silent in-place mutation of a running box.
  user_data_replace_on_change = true

  # ...and because that replacement DESTROYS the team's entire shared memory
  # — every share, receipt, member and the team token live in the SQLite file
  # on this instance's root volume — Terraform is not allowed to do it on its
  # own. Editing user_data.sh.tpl and running apply will now fail loudly
  # instead of quietly wiping the database.
  #
  # To intentionally rebuild the box: back up the database first (see
  # README.md), remove this lifecycle block, apply, then restore. To tear the
  # whole stack down, remove it and run terraform destroy.
  lifecycle {
    prevent_destroy = true

    # user_data.sh.tpl is expected to keep gaining setup steps over time (the
    # S3 backup automation in backup.tf/files/teamshare-backup.sh is the
    # first) without that ever being a live-instance event. Without this,
    # user_data_replace_on_change's own diff on this attribute would make
    # *every* future `terraform apply` — including ones with nothing to do
    # with the instance at all, like adding an unrelated S3 bucket — attempt
    # to replace this box, which prevent_destroy then turns into a hard
    # error blocking the whole apply. Ignoring drift on this one attribute
    # keeps that guarantee (this resource is never replaced by routine
    # apply) without the collateral damage of unrelated changes being
    # blocked too.
    #
    # This does not weaken prevent_destroy — it only means Terraform stops
    # treating user_data.sh.tpl edits as a pending change to react to. A
    # genuine, deliberate rebuild (back up the database, remove
    # prevent_destroy, apply, then restore, per README.md) must also remove
    # this ignore_changes entry, or the rebuilt instance will boot with
    # today's already-ignored user_data instead of the current template.
    ignore_changes = [user_data]
  }
}

# Caddy requests a Let's Encrypt certificate for <public-ip>.sslip.io on its
# own and retries automatically, so no wait loop is needed here — issuance
# succeeds as soon as the instance is reachable on port 80.
