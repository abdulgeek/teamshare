# Optional Elastic IP.
#
# Off by default because this account was at its EIP quota when teamshare was
# first deployed — all addresses were in use by other p3m infrastructure — so
# the instance falls back to its auto-assigned public IP.
#
# Why you want it on: without a stable address, STOPPING and starting the
# instance assigns a new public IP, which changes the <ip>.sslip.io hostname
# and forces every teammate to reconnect. (A plain reboot keeps the IP.) An
# Elastic IP removes that fragility permanently.
#
# Turning it on is NOT free of disruption: attaching an EIP changes the
# instance's public IP, so the URL changes once, and Caddy must be pointed at
# the new hostname and issued a fresh certificate. Do it BEFORE onboarding the
# team, or during a window where everyone can re-run setup. The exact
# post-attach steps are in README.md.
resource "aws_eip" "teamshare" {
  count  = var.use_elastic_ip ? 1 : 0
  domain = "vpc"

  tags = {
    Name = "teamshare"
  }
}

resource "aws_eip_association" "teamshare" {
  count         = var.use_elastic_ip ? 1 : 0
  instance_id   = aws_instance.teamshare.id
  allocation_id = aws_eip.teamshare[0].id
}
