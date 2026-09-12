#!/usr/bin/env python3
"""Presign an S3 GET and a PUT for the R1 transfer bench.

`aws s3 presign` signs GET only, so the PUT comes from botocore (boto3 in
shell.nix). Prints one JSON object: {"get": url, "put": url, "putKey": key}.

Usage: presign.py <bucket> <get-key> <put-key> [ttl-seconds]
"""
import json
import os
import sys

import boto3
from botocore.config import Config

bucket, get_key, put_key = sys.argv[1:4]
ttl = int(sys.argv[4]) if len(sys.argv) > 4 else 1800
region = os.environ.get("AWS_REGION", "eu-central-1")
# Regional virtual-hosted endpoint, SigV4: the global endpoint answers a fresh
# bucket with 307 redirects for a while, and a redirect breaks a curl PUT.
s3 = boto3.client(
    "s3",
    region_name=region,
    endpoint_url=f"https://s3.{region}.amazonaws.com",
    config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
)
get_url = s3.generate_presigned_url(
    "get_object", Params={"Bucket": bucket, "Key": get_key}, ExpiresIn=ttl, HttpMethod="GET"
)
put_url = s3.generate_presigned_url(
    "put_object", Params={"Bucket": bucket, "Key": put_key}, ExpiresIn=ttl, HttpMethod="PUT"
)
print(json.dumps({"get": get_url, "put": put_url, "putKey": put_key}))
