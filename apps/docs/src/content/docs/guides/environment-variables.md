---
title: Environment variables and secrets
description:
  Load project configuration, write-only secrets, and cluster bindings into future Mend workspaces.
sidebar:
  order: 4
---

Mend stores project environment input in two lanes. Both become environment variables in future
workspace processes, but they have different storage and read behavior.

| Lane          | Storage                            | Read behavior                            | Use for                                                  |
| ------------- | ---------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Configuration | Plaintext                          | Names and values can be read back        | Ports, modes, feature switches, public URLs              |
| Secrets       | Encrypted with a machine-local key | Names are visible; values are write-only | Passwords, tokens, private keys, credential-bearing URLs |

On a Kubernetes install a third source exists, [cluster bindings](#cluster-bindings): names of
cluster Secrets and ConfigMaps whose contents Mend never stores at all.

Changes apply from the next workspace launch. Running agents, shells, and Services keep the values
their workspace started with.

Anyone who can see the project can read its names. Only the people who manage it, its creator and
the organization's owners, can add, change, or remove entries, from the web app or the CLI.
Organization defaults do not include environment variables; each project holds its own.

## Load a `.env` file

From an adopted project:

```sh
mend env load
```

The default file is `.env`. Pass another path when needed:

```sh
mend env load .env.development
```

Use `--project` when the current directory does not identify the target project:

```sh
mend env load .env.development --project api
```

Mend parses the file, upserts accepted names, and reports malformed or rejected lines. Existing
entries with the same name are replaced.

## Secret routing

During import, names containing common secret markers such as `TOKEN`, `SECRET`, `PASSWORD`,
`PASSWD`, `CREDENTIAL`, or `APIKEY` go to Secrets. Names ending in `_KEY`, and the exact name `KEY`,
also go to Secrets.

Send the whole file to Secrets:

```sh
mend env load .env --secret
```

Send named values to Secrets while leaving the rest to automatic routing:

```sh
mend env load .env --secret DATABASE_URL,SENTRY_DSN
```

This is useful for URLs that embed a password but do not look secret from their name.

## Inspect stored names

```sh
mend env show
```

The command prints configuration names, secret names, and any cluster bindings, with a revision per
lane. It labels configuration as plaintext and never prints secret values. Cluster bindings show as
`secret/<name>` or `configmap/<name>` because the object names are all Mend knows.

## Edit in the web app

Open the project's **Setup** page. The Configuration and Secrets sections support create, rename,
replace, and remove operations. Secret rows only show whether a value is set. Members who do not
manage the project see a note in place of these sections.

Renaming a secret without entering another value preserves the stored value. Replacing it writes a
new encrypted value.

## Cluster bindings

On a Kubernetes install a project can bind cluster objects: each binding names a Kubernetes Secret
or ConfigMap in the platform's workspaces namespace whose keys become workspace environment. Mend
stores the binding itself, a kind plus an object name, and never the keys or values inside the
object. The Sealant worker resolves the object at each fresh workspace launch, so rotating a Secret
with `kubectl` applies from the next launch without touching Mend, and no value ever crosses Mend's
database.

The boundaries:

- Only objects the operator labeled for workspace environment resolve.
- Object names follow Kubernetes DNS-1123 subdomain grammar, and a project holds at most 16
  bindings.
- A project can also name a workspace service account, the Pod identity its workspaces run as. The
  operator allowlists which accounts may be requested.
- On a local-runner install, bindings do not resolve. A declared binding blocks launches there
  rather than shipping an incomplete environment; remove the bindings to launch on that install.

`mend env show` lists bindings and the service account alongside configuration and secret names. Add
and remove bindings and set the service account on the Setup page's **Cluster bindings** panel, or
from the terminal:

```sh
mend env cluster add secret app-env
mend env cluster add configmap app-config
mend env cluster remove secret/app-env
mend env cluster sa workspace-runner
mend env cluster sa --clear
```

Each command takes `--project` like `mend env load`. At each fresh workspace launch Mend forwards
the declared bindings to the platform verbatim; the worker resolves the objects server-side and
their keys become workspace environment. An install that cannot resolve them refuses the launch with
a failure naming every binding; remove the bindings in project setup to launch there.

## Reserved names

Mend rejects names that belong to the platform or can change process startup. Examples include:

- `PATH`, shell startup variables, and runtime injection variables such as `NODE_OPTIONS`;
- Git and SSH controls such as `GIT_SSH_COMMAND`, `GIT_CONFIG_GLOBAL`, and `SSH_AUTH_SOCK`, which
  the platform reserves. Mend wires the workspace [Git transport](/guides/git-access/) through
  system Git config (`core.sshCommand`) instead;
- `GITHUB_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`, which come from connected accounts;
- names beginning with `MEND_` or `SEALANT_`.

Use [provider accounts](/guides/provider-accounts/) for Claude, Codex, and GitHub credentials rather
than copying those credentials into project secrets.

## Security boundary

Secret values are encrypted at rest with a machine-local key. The API never returns them. At a fresh
launch, Mend decrypts the current set once and passes it through Sealant's transient secret channel.

Losing the machine key makes stored values unrecoverable. Re-enter them rather than expecting Mend
to reveal or export them.
