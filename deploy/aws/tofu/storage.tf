# Captures contain source and may contain harness credentials. No expiry policy:
# only the application's capture-chain-aware retention may decide what is dead.
resource "aws_s3_bucket" "captures" {
  bucket        = "${local.name}-captures-${local.account_id}-${local.region}"
  force_destroy = false
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = "${local.name}-artifacts-${local.account_id}-${local.region}"
  force_destroy = false
}

locals {
  buckets = {
    captures  = { id = aws_s3_bucket.captures.id, arn = aws_s3_bucket.captures.arn }
    artifacts = { id = aws_s3_bucket.artifacts.id, arn = aws_s3_bucket.artifacts.arn }
  }
}

resource "aws_s3_bucket_public_access_block" "poc" {
  for_each                = local.buckets
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "poc" {
  for_each = local.buckets
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "poc" {
  for_each = local.buckets
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "poc" {
  for_each = local.buckets
  bucket   = each.value.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  for_each = local.buckets
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "poc" {
  for_each   = local.buckets
  bucket     = each.value.id
  policy     = data.aws_iam_policy_document.bucket[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.poc]
}
