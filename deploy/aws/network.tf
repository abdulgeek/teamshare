# A minimal, self-contained public network for teamshare. See variables.tf
# (vpc_cidr) for why this exists instead of using a default VPC.

resource "aws_vpc" "teamshare" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
}

resource "aws_internet_gateway" "teamshare" {
  vpc_id = aws_vpc.teamshare.id
}

resource "aws_subnet" "teamshare" {
  vpc_id                  = aws_vpc.teamshare.id
  cidr_block              = var.vpc_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true
}

resource "aws_route_table" "teamshare" {
  vpc_id = aws_vpc.teamshare.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.teamshare.id
  }
}

resource "aws_route_table_association" "teamshare" {
  subnet_id      = aws_subnet.teamshare.id
  route_table_id = aws_route_table.teamshare.id
}
