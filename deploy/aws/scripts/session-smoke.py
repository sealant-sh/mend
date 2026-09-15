#!/usr/bin/env python3
"""Staged POC acceptance through Mend's public HTTP API; never prints auth material.

Requires the loopback-only UI port-forward. Saves a dedicated test account and
project/session IDs outside Git. Each phase is explicit; launch runs no provider
inference, only a supervised shell that writes a capture marker. No remote push.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE = "http://localhost:3105"
STATE = Path.home() / ".config/mend/aws-poc/smoke.json"


def save(state):
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(state, handle, indent=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("provision", "launch", "restore", "status", "stop"))
    parser.add_argument("--new-session", action="store_true", help="Keep the previous attempt and create another smoke session")
    args = parser.parse_args()
    if STATE.exists() and STATE.stat().st_mode & 0o077:
        raise RuntimeError("Smoke credentials must be mode 0600")
    state = json.loads(STATE.read_text()) if STATE.exists() else {}

    def request(method, path, body=None, authenticated=True):
        headers = {"Content-Type": "application/json", "Origin": BASE}
        if authenticated:
            headers["Authorization"] = "Bearer " + state["token"]
        req = Request(BASE + path, method=method, headers=headers,
                      data=json.dumps(body).encode() if body is not None else None)
        try:
            with urlopen(req, timeout=300) as response:
                raw = response.read()
                decoded = json.loads(raw) if raw else {}
                if not isinstance(decoded, dict):
                    raise RuntimeError(f"{method} {path}: expected a JSON object")
                return decoded
        except HTTPError as error:
            message = error.read().decode(errors="replace")
            for key in ("token", "password"):
                if state.get(key):
                    message = message.replace(state[key], "<redacted>")
            raise RuntimeError(f"{method} {path}: HTTP {error.code}: {message[:3000]}") from None

    if args.phase == "provision":
        if "token" not in state:
            state.setdefault("email", "aws-poc@localhost.invalid")
            state.setdefault("password", secrets.token_urlsafe(32))
            save(state)
            response = request("POST", "/api/auth/sign-up/email", {
                "email": state["email"], "password": state["password"], "name": "AWS capture proof",
            }, authenticated=False)
            state["token"] = response["token"]
            save(state)
        # MicroVM uses the separately built fixed AWS image, NOT this OCI result.
        # The provisioning builder still requires a base with git/node/npm.
        # This does NOT establish Debian or arbitrary OCI customization in the VM.
        request("PUT", "/api/settings/workspace-environment", {
            "mode": "custom", "baseImage": "node:24-bookworm",
            "packages": [], "setupCommands": [], "services": {"docker": False},
        })
        if "project" not in state:
            project = request("POST", "/api/projects", {
                "name": "aws-capture-proof", "source": "https://github.com/octocat/Hello-World.git",
            })
            state["project"] = project["id"]
            save(state)
            if project.get("hotSessions", 0) != 0:
                raise RuntimeError("Unexpected standby count; do not launch")
        if args.new_session and "session" in state:
            state.setdefault("previousSessions", []).append(state.pop("session"))
            save(state)
        if "session" not in state:
            attempt = len(state.get("previousSessions", [])) + 1
            session = request("POST", f'/api/projects/{state["project"]}/sessions', {
                "harness": "bash", "label": "AWS capture proof", "name": f"aws-capture-proof-{attempt}", "base": None,
            })
            state["session"] = session["id"]
            save(state)
        print(json.dumps({key: state[key] for key in ("project", "session")}, indent=2))
    elif args.phase in ("launch", "restore"):
        marker = "Mend AWS capture proof: persisted by the real executor"
        if args.phase == "restore":
            prior = request("GET", f'/api/sessions/{state["session"]}')
            if prior["currentAgent"] is None or prior["currentAgent"]["exitCode"] != 0:
                raise RuntimeError("First smoke command must have completed successfully")
            state["priorWorkspace"] = prior["session"]["sealantWorkspaceId"]
            state["priorRun"] = prior["session"]["sealantRunId"]
            # A plain command has no provider harness state to resume. Start a
            # new conversation on the SAME worktree, not a fresh clone.
            replacement = request("POST", f'/api/projects/{state["project"]}/sessions', {
                "harness": "bash", "label": "AWS restore proof",
                "name": prior["session"]["worktree"], "base": None,
            })
            if replacement["worktreeId"] != prior["session"]["worktreeId"]:
                raise RuntimeError("Replacement did not join the original worktree")
            state.setdefault("previousSessions", []).append(state["session"])
            state["session"] = replacement["id"]
            save(state)
            command = f"set -eu; test \"$(cat aws-capture-proof.txt)\" = '{marker}'; printf '%s\\n' 'replacement verified' > aws-capture-restore-proof.txt; /usr/local/bin/sealantctl --socket /run/sealant/control.sock capture flush; git status --short; sleep 3"
        else:
            command = f"set -eu; printf '%s\\n' '{marker}' > aws-capture-proof.txt; git status --short; sleep 5"
        result = request("POST", f'/api/sessions/{state["session"]}/launch', {"argv": ["bash", "-lc", command]})
        print(json.dumps({key: result.get(key) for key in ("id", "status", "sealantWorkspaceId", "sealantRunId")}, indent=2))
    elif args.phase == "status":
        result = request("GET", f'/api/sessions/{state["session"]}')
        print(json.dumps(result, indent=2))
    else:
        result = request("POST", f'/api/sessions/{state["session"]}/stop', {})
        print(json.dumps({key: result.get(key) for key in ("id", "status")}, indent=2))


if __name__ == "__main__":
    main()
