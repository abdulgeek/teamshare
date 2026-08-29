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
    Run this to read the team token off the box. It is generated on first
    boot and printed exactly once into the teamshare systemd unit's journal —
    it is never in Terraform state or this repo. This command only submits
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
