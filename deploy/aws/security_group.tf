# Inbound: 80 (Let's Encrypt HTTP-01 challenge + HTTP->HTTPS) and 443 only.
# No port 22 — administration is via SSM Session Manager (see iam.tf), so
# there is no SSH key to manage or leak.
resource "aws_security_group" "teamshare" {
  name        = "teamshare"
  description = "teamshare: inbound HTTP/HTTPS only, no SSH (SSM Session Manager instead)"
  vpc_id      = aws_vpc.teamshare.id

  ingress {
    description = "HTTP (ACME HTTP-01 challenge for Lets Encrypt)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
