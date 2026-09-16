#!/usr/bin/env python3
"""Render non-secret Mend Helm values and Kubernetes foundations from `tofu output -json`."""
import json
import sys

outputs = json.load(sys.stdin)

def value(name):
    return outputs[name]["value"]

kind = sys.argv[1] if len(sys.argv) == 2 else "values"
if kind == "foundations":
    result = {
        "apiVersion": "v1", "kind": "List", "items": [
            {"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass", "metadata": {"name": "mend-gp3"},
             "provisioner": "ebs.csi.aws.com", "parameters": {"type": "gp3", "encrypted": "true"},
             "volumeBindingMode": "WaitForFirstConsumer", "reclaimPolicy": "Delete", "allowVolumeExpansion": True},
            {"apiVersion": "v1", "kind": "ServiceAccount", "metadata": {"name": "mend-api", "namespace": "mend", "annotations": {
                "eks.amazonaws.com/role-arn": value("application_role_arns")["mend"],
                "eks.amazonaws.com/sts-regional-endpoints": "true"}}, "automountServiceAccountToken": False},
        ]}
elif kind == "values":
    result = {
        "image": {"tag": "0.27.5"},
        "postgres": {"enabled": False},
        "store": {"create": {"enabled": True, "storageClassName": "mend-gp3", "size": "20Gi"}},
        "captureStore": {"blobStore": {
            "url": "s3://" + value("capture_bucket") + "?region=" + value("region"),
            "publicUrl": value("capture_s3_endpoint"), "useDefaultCredentials": True}},
        "api": {"serviceAccountName": "mend-api", "trustedProxyCidrs": ["10.42.16.0/20", "10.42.32.0/20"],
                "resources": {"requests": {"cpu": "250m", "memory": "768Mi"}, "limits": {"cpu": "2", "memory": "3Gi"}}},
        "web": {"appUrl": "http://localhost:3105"},
        "sessionChannel": {"advertisedUrl": value("session_endpoint_url"), "service": {"type": "NodePort", "nodePort": 31006}},
        # The internal NLB SNATs to its private subnet addresses. Its security group admits
        # the MicroVM connector only; this network policy grants the session port only.
        "networkPolicies": {"sessionChannelCidrs": ["10.42.16.0/20", "10.42.32.0/20"]},
        "extraEnv": [{"name": "AWS_REGION", "value": value("region")},
                     {"name": "AWS_EC2_METADATA_DISABLED", "value": "true"}],
    }
else:
    raise SystemExit("Use values or foundations")
print(json.dumps(result, indent=2))
