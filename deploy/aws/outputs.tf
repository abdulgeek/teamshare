output "elastic_ip" {
  description = "teamshare's Elastic IP."
  value       = aws_instance.teamshare.public_ip
}

output "url" {
  description = "teamshare's HTTPS URL (Caddy auto-provisions a Let's Encrypt cert for this sslip.io hostname)."
  value       = "https://${aws_instance.teamshare.public_ip}.sslip.io"
}

output "instance_id" {
  description = "EC2 instance ID, needed for SSM commands."
  value       = aws_instance.teamshare.id
}

output "ssm_read_team_token_command" {
  description = <<-EOT
    BREAK-GLASS ONLY — not the way to onboard a team; see deploy/aws/README.md.

    teamshare is multi-team now: a lead creates their own team (and gets
    their own token) with the standalone `teamshare-team.mjs create-team`
    script, authenticated by the signup secret (see the `signup_secret`
    variable), with no AWS/SSM access needed at all.

    This command instead reads the *original* pre-migration token out of
    journal history — the one plaintext token this server ever printed
    unprompted, on its very first boot, before multi-team existed. It is
    still the team named "default" today. Useful only if whoever owns that
    team lost their token before ever rotating it themselves (`POST
    /teams/rotate` is what they should reach for normally) or if journal
    retention has not yet rotated the line away. This command only submits
    the SSM command; see deploy/aws/README.md for fetching the output.
  EOT
  value = join(" ", [
    "aws ssm send-command",
    "--instance-ids", aws_instance.teamshare.id,
    "--document-name AWS-RunShellScript",
    "--parameters", "'commands=[\"journalctl -u teamshare --no-pager | grep -A2 \\\"Team token\\\"\"]'",
    "--region", var.aws_region,
  ])
}

output "ssm_show_signup_secret_command" {
  description = <<-EOT
    BREAK-GLASS — recovers the instance signup secret when it was left unset
    at deploy time (the `signup_secret` variable defaults to null, in which
    case the server generated one on first boot and — unlike the old team
    token — never logs it anywhere; see variables.tf). Not needed at all if
    you set `signup_secret` explicitly, since then it's just whatever you set
    in Terraform. This command only submits the SSM command; the result comes
    back the same way as ssm_read_team_token_command's (see
    deploy/aws/README.md).
  EOT
  value = join(" ", [
    "aws ssm send-command",
    "--instance-ids", aws_instance.teamshare.id,
    "--document-name AWS-RunShellScript",
    "--parameters", "'commands=[\"sudo -u teamshare /usr/local/bin/node /opt/teamshare/packages/server/dist/cli.js signup-secret --show --db /var/lib/teamshare/teamshare.db\"]'",
    "--region", var.aws_region,
  ])
}
