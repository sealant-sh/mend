#!/usr/bin/env python3
"""Render the Sealant AWS Kubernetes manifest without contacting AWS or Kubernetes."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "manifest.template.yaml"
DNS_LABEL = re.compile(r"^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$")
IAM_ROLE_ARN = re.compile(r"^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$")
MICROVM_IMAGE_ARN = re.compile(
    r"^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:microvm-image:[A-Za-z0-9_-]+$"
)
CONNECTOR_ARN = re.compile(
    r"^arn:aws[a-z-]*:lambda:[a-z0-9-]+:(?:[0-9]{12}|aws):network-connector:.+$"
)
REGION = re.compile(r"^[a-z]{2}(?:-[a-z]+)+-[0-9]$")
CONFIG_VALUE = re.compile(r"^[A-Za-z0-9._/#-]+$")
SECRET_KEY = re.compile(r"^[A-Za-z0-9._-]+$")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--outputs", required=True, type=Path, help="tofu output -json file")
    result.add_argument("--microvm-image-arn", required=True)
    result.add_argument("--microvm-image-version", required=True)
    result.add_argument("--api-role-arn")
    result.add_argument("--worker-role-arn")
    result.add_argument("--namespace", default="sealant")
    result.add_argument("--build-namespace", default="sealant-build")
    result.add_argument("--mend-namespace", default="mend")
    result.add_argument("--database-secret", default="sealant-secrets")
    result.add_argument("--database-secret-key", default="DATABASE_URL")
    result.add_argument("--credentials-secret", default="sealant-secrets")
    result.add_argument("--credentials-secret-key", default="SEALANT_CREDENTIALS_KEY")
    result.add_argument("--service-keys-secret", default="sealant-secrets")
    result.add_argument("--service-keys-secret-key", default="SEALANT_SERVICE_KEYS")
    result.add_argument("--control-secret", default="sealant-secrets")
    result.add_argument("--control-secret-key", default="SEALANT_CONTROL_BEARER_TOKEN")
    result.add_argument("--output", type=Path, help="write here instead of stdout")
    return result


def output_value(outputs: dict[str, Any], *names: str) -> str:
    for name in names:
        item = outputs.get(name)
        if isinstance(item, dict):
            value = item.get("value")
            if isinstance(value, str) and value:
                return value
    joined = ", ".join(names)
    raise ValueError(f"tofu output JSON is missing a non-empty string output: {joined}")


def application_role(outputs: dict[str, Any], name: str) -> str | None:
    item = outputs.get("application_role_arns")
    if not isinstance(item, dict):
        return None
    roles = item.get("value")
    if not isinstance(roles, dict):
        return None
    role = roles.get(name)
    return role if isinstance(role, str) and role else None


def validate(label: str, value: str, pattern: re.Pattern[str]) -> str:
    if not pattern.fullmatch(value):
        raise ValueError(f"invalid {label}: {value!r}")
    return value


def dns(label: str, value: str) -> str:
    if len(value) > 63:
        raise ValueError(f"{label} exceeds 63 characters")
    return validate(label, value, DNS_LABEL)


def main() -> int:
    args = parser().parse_args()
    try:
        raw = json.loads(args.outputs.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("tofu output JSON must be an object")

        region = validate("region", output_value(raw, "region"), REGION)
        account_id = output_value(raw, "account_id")
        if not re.fullmatch(r"[0-9]{12}", account_id):
            raise ValueError(f"invalid account id: {account_id!r}")
        api_role = (
            args.api_role_arn
            or application_role(raw, "sealant_api")
            or output_value(raw, "sealant_api_irsa_role_arn", "sealant_api_role_arn")
        )
        worker_role = (
            args.worker_role_arn
            or application_role(raw, "sealant_worker")
            or output_value(raw, "sealant_worker_irsa_role_arn", "sealant_worker_role_arn")
        )
        values = {
            "__NAMESPACE__": dns("namespace", args.namespace),
            "__BUILD_NAMESPACE__": dns("build namespace", args.build_namespace),
            "__MEND_NAMESPACE__": dns("Mend namespace", args.mend_namespace),
            "__API_ROLE_ARN__": validate("API role ARN", api_role, IAM_ROLE_ARN),
            "__WORKER_ROLE_ARN__": validate("worker role ARN", worker_role, IAM_ROLE_ARN),
            "__REGION__": region,
            "__MICROVM_IMAGE_ARN__": validate(
                "MicroVM image ARN", args.microvm_image_arn, MICROVM_IMAGE_ARN
            ),
            "__MICROVM_IMAGE_VERSION__": args.microvm_image_version,
            "__MICROVM_EXEC_ROLE_ARN__": validate(
                "MicroVM execution role ARN",
                output_value(raw, "microvm_exec_role_arn"),
                IAM_ROLE_ARN,
            ),
            "__MICROVM_EGRESS_CONNECTOR__": validate(
                "MicroVM egress connector ARN",
                output_value(raw, "vpc_egress_connector_arn"),
                CONNECTOR_ARN,
            ),
            "__MICROVM_INGRESS_CONNECTOR__": (
                f"arn:aws:lambda:{region}:aws:network-connector:"
                "aws-network-connector:ALL_INGRESS"
            ),
            "__MICROVM_LOG_GROUP__": output_value(raw, "microvm_exec_log_group"),
            "__DATABASE_SECRET__": dns("database Secret", args.database_secret),
            "__DATABASE_SECRET_KEY__": args.database_secret_key,
            "__CREDENTIALS_SECRET__": dns("credentials Secret", args.credentials_secret),
            "__CREDENTIALS_SECRET_KEY__": args.credentials_secret_key,
            "__SERVICE_KEYS_SECRET__": dns("service-keys Secret", args.service_keys_secret),
            "__SERVICE_KEYS_SECRET_KEY__": args.service_keys_secret_key,
            "__CONTROL_SECRET__": dns("control Secret", args.control_secret),
            "__CONTROL_SECRET_KEY__": args.control_secret_key,
        }
        for label in ("__MICROVM_IMAGE_VERSION__", "__MICROVM_LOG_GROUP__"):
            validate(label, values[label], CONFIG_VALUE)
        for label in (
            "__DATABASE_SECRET_KEY__",
            "__CREDENTIALS_SECRET_KEY__",
            "__SERVICE_KEYS_SECRET_KEY__",
            "__CONTROL_SECRET_KEY__",
        ):
            validate(label, values[label], SECRET_KEY)
        if args.namespace == args.build_namespace:
            raise ValueError("the BuildKit namespace must be separate from the Sealant namespace")
        for label in ("__API_ROLE_ARN__", "__WORKER_ROLE_ARN__", "__MICROVM_EXEC_ROLE_ARN__"):
            if f"::{account_id}:" not in values[label]:
                raise ValueError(f"{label} is not in tofu account {account_id}")
        image_parts = values["__MICROVM_IMAGE_ARN__"].split(":")
        if image_parts[3] != region or image_parts[4] != account_id:
            raise ValueError("MicroVM image ARN region/account does not match tofu outputs")

        rendered = TEMPLATE.read_text(encoding="utf-8")
        for placeholder, value in values.items():
            rendered = rendered.replace(placeholder, value)
        unresolved = sorted(set(re.findall(r"__[A-Z0-9_]+__", rendered)))
        if unresolved:
            raise ValueError(f"unresolved placeholders: {', '.join(unresolved)}")
        if "SEALANT_K8S_NAMESPACE" in rendered:
            raise ValueError("SEALANT_K8S_NAMESPACE must stay absent in this MicroVM deployment")

        if args.output is None:
            sys.stdout.write(rendered)
        else:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered, encoding="utf-8")
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"render: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
