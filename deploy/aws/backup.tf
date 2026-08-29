# Automated S3 backups of the teamshare database.
#
# Strictly additive: a private S3 bucket plus an IAM policy attached to the
# *existing* teamshare-ec2 role (defined in iam.tf). Nothing here touches
# aws_instance.teamshare, its security group, or its network — so applying
# this does not replace or even modify the running instance.
#
# The actual backup logic (the script that runs on the box) lives in exactly
# one file, deploy/aws/files/teamshare-backup.sh — see that file and
# user_data.sh.tpl for how it's shipped to the instance without drifting.

data "aws_caller_identity" "current" {}

# --- Bucket -------------------------------------------------------------
# Name must be globally unique across all of S3; deriving it from the
# account ID guarantees that without any manual coordination.
resource "aws_s3_bucket" "backups" {
  bucket = "teamshare-backups-${data.aws_caller_identity.current.account_id}"

  # No prevent_destroy here on purpose (unlike aws_instance.teamshare): this
  # bucket is a *copy* of the data, not the sole copy. Losing it means losing
  # backups, not the live database. Versioning below still protects against
  # an accidental single-object delete or overwrite.
}

# The contents are sensitive (the team token and every share), so: no public
# access of any kind, under any mechanism, ever.
resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Default server-side encryption for every object, even ones uploaded without
# an explicit encryption header.
resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Versioning: an accidental overwrite or delete of a backup key doesn't lose
# the prior version outright — paired with the lifecycle rule below so
# noncurrent versions don't accumulate forever.
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Retention: keep current backups indefinitely (they're the point of this
# bucket), but don't let noncurrent versions or abandoned multipart uploads
# grow the bucket without bound.
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  # Required whenever versioning is configured via a separate resource, so
  # this rule only takes effect once versioning actually exists.
  depends_on = [aws_s3_bucket_versioning.backups]

  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-noncurrent-versions-and-abort-incomplete-uploads"
    status = "Enabled"

    filter {} # applies to every object in the bucket

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --- IAM: least privilege, attached to the existing role -----------------
# Nothing wider than what the backup script actually needs: write + read its
# own objects, and list the bucket (to find the newest backup when
# restoring). No s3:*, no access to any other bucket.
resource "aws_iam_policy" "teamshare_backup_s3" {
  name        = "teamshare-backup-s3"
  description = "Least-privilege S3 access for teamshare's automated database backups."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "TeamshareBackupObjectReadWrite"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.backups.arn}/*"
      },
      {
        Sid      = "TeamshareBackupListBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.backups.arn
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "teamshare_backup_s3" {
  role       = aws_iam_role.teamshare.name
  policy_arn = aws_iam_policy.teamshare_backup_s3.arn
}

# --- Outputs ---------------------------------------------------------------
output "backup_bucket" {
  description = "S3 bucket receiving teamshare's daily database backups."
  value       = aws_s3_bucket.backups.bucket
}

output "list_recent_backups_command" {
  description = "Run this to list backups, oldest first (newest at the bottom)."
  value = join(" ", [
    "aws s3 ls",
    "s3://${aws_s3_bucket.backups.bucket}/teamshare/",
    "--recursive",
    "--region", var.aws_region,
    "| sort | tail -n 20",
  ])
}
