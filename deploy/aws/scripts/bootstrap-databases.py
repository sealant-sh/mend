#!/usr/bin/env python3
"""Bootstrap the two PlanetScale databases over PrivateLink from an ephemeral EKS pod.

Requires explicit KUBECONFIG for mend-aws-capture-poc and private role JSON files
from `pscale role create`. Never prints passwords or puts them in argv/Git/Tofu.
The bootstrap role needs postgres membership. The stable postgres role owns both
databases; each application gets connect/create rights only in its own database,
not branch-wide postgres/read-all/write-all privileges.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import subprocess
from urllib.parse import quote

HOST = "aws-eu-central-1-2.private-pg.psdb.cloud"
ROOT = Path.home() / ".config/mend/aws-poc"
POD = "mend-db-bootstrap"


def kubectl(*args, stdin=None, sensitive=False):
    result = subprocess.run(["kubectl", *args], input=stdin, text=True, capture_output=True)
    if result.returncode:
        if not sensitive:
            print(result.stdout)
            print(result.stderr)
        raise RuntimeError("kubectl operation failed" if sensitive else "kubectl " + args[0] + " failed")
    return result.stdout


def apply(resource, sensitive=False):
    return kubectl("apply", "--server-side", "--field-manager=mend-aws-bootstrap", "-f", "-", stdin=json.dumps(resource), sensitive=sensitive)


def role(name):
    path = ROOT / (name + "-role.json")
    if path.stat().st_mode & 0o077:
        raise RuntimeError("Credential file must be mode 0600: " + str(path))
    data = json.loads(path.read_text())
    if not data.get("password") or not re.fullmatch(r"pscale_api_[a-z0-9]+\.[a-z0-9]+", data["username"]):
        raise RuntimeError("Invalid or missing role credentials: " + name)
    return data


def secret(namespace, name, values):
    apply({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "namespace": namespace},
           "type": "Opaque", "data": {key: base64.b64encode(value.encode()).decode() for key, value in values.items()}}, sensitive=True)


def database_url(data, database):
    return "postgresql://" + quote(data["username"], safe="") + ":" + quote(data["password"], safe="") + "@" + HOST + ":5432/" + database + "?sslmode=verify-full"


def app_identity():
    path = ROOT / "application-identity.json"
    if path.exists():
        if path.stat().st_mode & 0o077:
            raise RuntimeError("Application identity must be mode 0600")
        data = json.loads(path.read_text())
        for key in ("auth", "service", "control", "cipher"):
            if not data.get(key):
                raise RuntimeError("Incomplete saved identity; refusing to rotate it")
        return data
    data = {"auth": secrets.token_hex(32), "service": secrets.token_hex(32),
            "control": secrets.token_hex(32), "cipher": base64.b64encode(secrets.token_bytes(32)).decode()}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle)
        handle.flush()
        os.fsync(handle.fileno())
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inspect", action="store_true", help="Read connection limits and counts only; do not change SQL grants or application secrets")
    args = parser.parse_args()
    if not os.environ.get("KUBECONFIG"):
        raise RuntimeError("Set the explicit POC KUBECONFIG; never use an implicit current cluster")
    if kubectl("config", "current-context").strip() != "mend-aws-capture-poc":
        raise RuntimeError("Refusing a kubeconfig context other than mend-aws-capture-poc")
    bootstrap = role("bootstrap")
    applications = {"mend": role("mend-app"), "sealant_control_plane": role("sealant-app")}
    for namespace in ("mend", "sealant"):
        apply({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace}})
    ca_path = ssl.get_default_verify_paths().cafile
    if not ca_path:
        raise RuntimeError("No operator CA trust bundle found; TLS verification remains required")
    apply({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": POD + "-ca", "namespace": "mend"},
           "data": {"ca-certificates.crt": Path(ca_path).read_text()}})
    secret("mend", POD, {"PGHOST": HOST, "PGUSER": bootstrap["username"], "PGPASSWORD": bootstrap["password"],
                          "PGDATABASE": "postgres", "PGPORT": "5432", "PGSSLMODE": "verify-full",
                          "PGSSLROOTCERT": "/etc/ssl/certs/ca-certificates.crt", "PGCONNECT_TIMEOUT": "15"})
    kubectl("-n", "mend", "delete", "pod", POD, "--ignore-not-found", "--wait=true")
    try:
        apply({"apiVersion": "v1", "kind": "Pod", "metadata": {"name": POD, "namespace": "mend"},
               "spec": {"restartPolicy": "Never", "automountServiceAccountToken": False,
                        "volumes": [{"name": "ca", "configMap": {"name": POD + "-ca"}}],
                        "containers": [{"name": "psql", "image": "postgres:17-bookworm", "command": ["sleep", "1800"],
                                        "volumeMounts": [{"name": "ca", "mountPath": "/etc/ssl/certs", "readOnly": True}],
                                        "envFrom": [{"secretRef": {"name": POD}}],
                                        "resources": {"requests": {"cpu": "10m", "memory": "32Mi"}, "limits": {"cpu": "250m", "memory": "256Mi"}},
                                        "securityContext": {"allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}}}]}})
        kubectl("-n", "mend", "wait", "--for=condition=Ready", "pod/" + POD, "--timeout=180s")
        print(kubectl("-n", "mend", "exec", POD, "--", "getent", "hosts", HOST).strip())
        statements = ["\\conninfo", "SELECT current_database(), current_user, inet_server_addr(), version();"]
        if args.inspect:
            statements.extend([
                "SELECT name, setting, unit, source FROM pg_settings WHERE name IN ('max_connections','superuser_reserved_connections','reserved_connections','shared_buffers','work_mem');",
                "SELECT datname, usename, application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3,4 ORDER BY count(*) DESC;",
            ])
            print(kubectl("-n", "mend", "exec", "-i", POD, "--", "psql", "-X", "-v", "ON_ERROR_STOP=1", stdin="\n".join(statements) + "\n"))
            return
        for database, data in applications.items():
            owner = data["username"].split(".")[0]
            statements.extend([
                f"DO $$ BEGIN IF pg_has_role('{owner}', 'postgres', 'MEMBER') OR pg_has_role('{owner}', 'pg_read_all_data', 'MEMBER') OR pg_has_role('{owner}', 'pg_write_all_data', 'MEMBER') THEN RAISE EXCEPTION 'Application role has branch-wide privileges; refusing deployment'; END IF; END $$;",
                "\\connect postgres",
                f"SELECT format('CREATE DATABASE %I OWNER postgres', '{database}') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '{database}')\\gexec",
                f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_database WHERE datname='{database}' AND pg_get_userbyid(datdba)='postgres') THEN RAISE EXCEPTION 'Existing database owner differs; refusing takeover'; END IF; END $$;",
                f'REVOKE ALL ON DATABASE "{database}" FROM PUBLIC;',
                f'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "{database}" TO "{owner}";',
                f"\\connect {database}",
                f'GRANT USAGE, CREATE ON SCHEMA public TO "{owner}";',
            ])
        print(kubectl("-n", "mend", "exec", "-i", POD, "--", "psql", "-X", "-v", "ON_ERROR_STOP=1", stdin="\n".join(statements) + "\n"))
        identity = app_identity()
        secret("mend", "mend-secrets", {"DATABASE_URL": database_url(applications["mend"], "mend"),
                                        "BETTER_AUTH_SECRET": identity["auth"], "SEALANT_SERVICE_KEY": identity["service"]})
        secret("sealant", "sealant-secrets", {"DATABASE_URL": database_url(applications["sealant_control_plane"], "sealant_control_plane"),
                                              "SEALANT_CREDENTIALS_KEY": identity["cipher"], "SEALANT_SERVICE_KEYS": identity["service"],
                                              "SEALANT_CONTROL_BEARER_TOKEN": identity["control"]})
        print("Private DNS and verified TLS succeeded. Separate databases and application secrets are ready.")
    finally:
        kubectl("-n", "mend", "delete", "pod", POD, "--ignore-not-found", "--wait=false")
        kubectl("-n", "mend", "delete", "secret", POD, "--ignore-not-found")
        kubectl("-n", "mend", "delete", "configmap", POD + "-ca", "--ignore-not-found")


if __name__ == "__main__":
    main()
