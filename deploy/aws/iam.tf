# Instance profile carrying only the AWS-managed SSM policy, so the instance
# can be administered with `aws ssm send-command` / Session Manager — no SSH
# key, no port 22.
resource "aws_iam_role" "teamshare" {
  name = "teamshare-ec2"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.teamshare.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "teamshare" {
  name = "teamshare-ec2"
  role = aws_iam_role.teamshare.name
}
