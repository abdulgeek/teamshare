# Allocated as its own resource, independent of the instance, so the address
# is known before the instance exists — the TLS hostname (<ip>.sslip.io) is
# templated into user_data (see ec2.tf), which needs the IP up front.
# Associated to the instance separately (aws_eip_association in ec2.tf) once
# the instance exists.
resource "aws_eip" "teamshare" {
  domain = "vpc"
}
