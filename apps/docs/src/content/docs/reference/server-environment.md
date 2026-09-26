---
title: Server environment
description:
  Every environment variable the Mend server reads, with its default, and how to set them on the
  Docker install and on Kubernetes.
sidebar:
  order: 2
---

The Mend server (the API, its workers and the web tier) reads its configuration from environment
variables. Most have a default that suits a single machine. A few are checked at start, and a value
that contradicts another refuses to start with a sentence that names it.

The CLI reads its own variables (`MEND_URL`, `MEND_TOKEN`, `MEND_DETACH_KEY`), listed in
[CLI configuration](/reference/cli/#cli-configuration). A workspace's own environment is set per
project, in [Environment variables](/guides/environment-variables/).

## Origins, secrets and processes

| Variable                      | Default                    | What it does                                                                                                             |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `APP_URL`                     | `http://localhost:3105`    | The exact browser origin, with no path or trailing slash. Links use it, and cookies are `Secure` when it is `https`.     |
| `MEND_ALLOWED_ORIGINS`        | `[]`                       | A JSON array of further exact browser origins. No wildcards.                                                             |
| `MEND_TRUSTED_PROXIES`        | empty                      | Comma-separated CIDRs of the proxy hops whose `X-Forwarded-For` entries Mend believes.                                   |
| `BETTER_AUTH_SECRET`          | a development value        | The secret sign-in sessions are signed with. Set it in every deployment.                                                 |
| `BETTER_AUTH_TRUSTED_ORIGINS` | unset                      | Must stay unset or empty; any other value refuses to start. Origins come from `APP_URL` and `MEND_ALLOWED_ORIGINS` only. |
| `MEND_MODE`                   | `all`                      | Which halves of the API process run: `all`, `api` (HTTP only) or `worker`. `web` is read as `api`.                       |
| `PORT`                        | `3101` (API), `3105` (web) | The port the process listens on.                                                                                         |
| `MEND_API_URL`                | `http://localhost:3101`    | Web tier: the API it proxies `/api` to.                                                                                  |
| `MEND_APP_URL`                | unset                      | Web tier: an app server already running. Unset, the web tier starts its own on `127.0.0.1:3210`.                         |
| `MEND_VERSION`                | `dev`                      | The version `/health` reports and the reassessment gate item compares. Release images set it.                            |

## Database

| Variable                      | Default                                    | What it does                                                                            |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | `postgres://mend:mend@localhost:5434/mend` | Mend's Postgres database. The default is the development one; every deployment sets it. |
| `MEND_DATABASE_POOL_MAX`      | `6`                                        | Connections in the pool for Mend's queries.                                             |
| `MEND_JOBS_POOL_MAX`          | `3`                                        | Connections in the job queue's (pg-boss) pool.                                          |
| `MEND_AUTH_DATABASE_POOL_MAX` | `3`                                        | Connections in the sign-in (Better Auth) pool.                                          |

Mend also holds one connection for `LISTEN`, so the caps above total 13 at full load. They must fit
under the Postgres server's `max_connections` together with Sealant's pools when both databases
share a server. See
[Troubleshooting](/operate/troubleshooting/#the-database-runs-out-of-connections).

## Sealant

| Variable              | Default                 | What it does                                                                          |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `SEALANT_BASE_URL`    | `http://localhost:8080` | The Sealant API Mend calls.                                                           |
| `SEALANT_SERVICE_KEY` | unset                   | The service key Mend presents to Sealant. `SEALANT_API_KEY` is read when it is unset. |

## Store and capture

| Variable                                     | Default                      | What it does                                                                                                                                             |
| -------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEND_STORE_ROOT`                            | `~/.config/mend/store`       | The store directory: bare repositories, the runner cache, references. Follows `XDG_CONFIG_HOME`.                                                         |
| `MEND_KEYS_ROOT`                             | `~/.config/mend/keys`        | Where Mend keys (`mend keys init`) are kept.                                                                                                             |
| `MEND_SESSION_STORE`                         | `captured`                   | `captured` ships each session's work to the bucket. `colocated` is deprecated and logs a warning at start.                                               |
| `MEND_BLOB_STORE`                            | `<store root>/_blobs`        | The capture store's bucket: `dir:///absolute/path`, or `s3://<bucket>?endpoint=<url>&region=<name>&forcePathStyle=<bool>`.                               |
| `MEND_BLOB_STORE_PUBLIC_URL`                 | unset                        | The bucket endpoint presigned URLs name, when workspaces reach it at another address than Mend does. Unset, they name the endpoint in `MEND_BLOB_STORE`. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | unset                        | Credentials for an `s3://` bucket, read through the AWS SDK's default credential chain.                                                                  |
| `MEND_CAPTURE_MULTIPART_THRESHOLD`           | `16777216` (16 MiB)          | Captures at or above this size upload in parts.                                                                                                          |
| `MEND_CAPTURE_MULTIPART_PART_SIZE`           | `16777216` (16 MiB)          | The size of one part. At least 5 MiB, S3's minimum.                                                                                                      |
| `MEND_CAPTURE_BYTE_QUOTA_FLOOR`              | `8589934592` (8 GiB)         | The smallest byte quota a session gets for its captures.                                                                                                 |
| `MEND_CAPTURE_REQUIRE_SIZES`                 | `false`                      | `true` refuses a capture upload that does not declare its size. Part of the multi mode gate.                                                             |
| `MEND_RUN_DIR`                               | `<store root>/_run/sessions` | Where per-session run directories live.                                                                                                                  |

## Session channel

Workspaces reach their session over a mounted Unix socket by default, or over a network channel when
`MEND_SESSION_ENDPOINT_LISTEN` is set.

| Variable                         | Default | What it does                                                                                                                                        |
| -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEND_DEPLOYMENT_MODE`           | `local` | `local` or `kubernetes`. In `kubernetes`, the session engine refuses to start without a network channel.                                            |
| `MEND_SESSION_ENDPOINT_LISTEN`   | unset   | `host:port` the network session channel listens on.                                                                                                 |
| `MEND_SESSION_ENDPOINT_URL`      | unset   | The address workspaces use to reach the channel. Required with `MEND_SESSION_ENDPOINT_LISTEN`.                                                      |
| `MEND_SESSION_ENDPOINT_TLS_CERT` | unset   | The channel's certificate file. Set with `MEND_SESSION_ENDPOINT_TLS_KEY`, and the URL must then be `https`.                                         |
| `MEND_SESSION_ENDPOINT_TLS_KEY`  | unset   | The channel's private key file.                                                                                                                     |
| `MEND_SESSION_ENDPOINT_CA_FILE`  | unset   | PEM roots workspaces verify the channel's certificate against, when a private CA signed it.                                                         |
| `MEND_BLOB_STORE_CA_FILE`        | unset   | PEM roots workspaces verify the bucket's certificate against.                                                                                       |
| `MEND_EXECUTOR_NETWORK`          | unset   | `private` states that executors reach the channel and the bucket over a network you control, so plain HTTP may be dialled. The only accepted value. |

## Tenancy, git and services

| Variable                         | Default     | What it does                                                                                                                                                                                                                                                 |
| -------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MEND_TENANCY`                   | `single`    | `single` or `multi`. `multi` refuses to start while the multi mode gate has open items (`mend operator gate`).                                                                                                                                               |
| `MEND_SOURCE_POLICY`             | `operator`  | Where Mend's own git (adoption, reference repositories, dotfiles) may reach. `operator` allows private networks and never the metadata service. `tenant` refuses private, reserved and local addresses and `git://`, and pins git to the address it checked. |
| `MEND_SOURCE_ALLOWED_HOSTS`      | empty       | Comma-separated host names or CIDRs on a private network that the `tenant` policy may still reach. Loopback and the metadata service can never be allowed.                                                                                                   |
| `MEND_GIT_TRANSPORT_BIND_ORIGIN` | `true`      | A workspace's git transport signs only for its project's remote. `false` lets it sign for any remote.                                                                                                                                                        |
| `MEND_SERVICE_HOSTS`             | `127.0.0.1` | Comma-separated literal IP addresses supervised Service listeners bind. Wildcard and public addresses are refused. Anything but loopback opens a multi mode gate item.                                                                                       |
| `MEND_SERVICE_PORT_MIN`          | `43100`     | The lowest port a Service listener takes.                                                                                                                                                                                                                    |
| `MEND_SERVICE_PORT_MAX`          | `43999`     | The highest port a Service listener takes.                                                                                                                                                                                                                   |

## Exposure

See [Exposure and the public gate](/operate/exposure/) for what each item means.

| Variable                   | Default    | What it does                                                                                                                                        |
| -------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEND_EXPOSURE`            | `private`  | How the instance is reached, as you declare it: `loopback`, `private` or `public`. `public` refuses to start while an observable gate item is open. |
| `MEND_EXPOSURE_DECLARED`   | empty      | Comma-separated gate items you verified from outside: `core-private`, `edge-tls`. Any other name refuses to start.                                  |
| `MEND_EXPOSURE_REASSESSED` | unset      | The version you recorded an independent security reassessment of. It counts only while it equals `MEND_VERSION`.                                    |
| `MEND_URL_BEARERS`         | `accept`   | `accept` still reads a bearer from `?token=` on a socket URL and logs it; `refuse` answers 400.                                                     |
| `MEND_ERROR_DETAIL`        | `redacted` | `verbose` turns off the scrubbing of error responses, for debugging a private instance.                                                             |

## Budgets

`0` turns one budget off, and the public exposure gate needs all of them on. What each bounds is in
[Budgets](/operate/exposure/#budgets).

| Variable                                       | Default    |
| ---------------------------------------------- | ---------- |
| `MEND_BUDGET_BODY_BYTES`                       | `1048576`  |
| `MEND_BUDGET_UPLOAD_BODY_BYTES`                | `25165824` |
| `MEND_BUDGET_FRAME_BYTES`                      | `1048576`  |
| `MEND_BUDGET_ADDRESS_REQUESTS_PER_MINUTE`      | `1200`     |
| `MEND_BUDGET_CREDENTIAL_REQUESTS_PER_MINUTE`   | `1200`     |
| `MEND_BUDGET_SIGN_IN_ATTEMPTS_PER_MINUTE`      | `20`       |
| `MEND_BUDGET_ACCOUNT_LIVE_SESSIONS`            | `24`       |
| `MEND_BUDGET_ORGANIZATION_LIVE_SESSIONS`       | `120`      |
| `MEND_BUDGET_ACCOUNT_LAUNCHES_IN_FLIGHT`       | `4`        |
| `MEND_BUDGET_BUNDLE_BYTES`                     | `67108864` |
| `MEND_BUDGET_ACCOUNT_ORIGIN_CHECKS_PER_MINUTE` | `30`       |
| `MEND_BUDGET_ACCOUNT_EVENT_STREAMS`            | `12`       |
| `MEND_BUDGET_ACCOUNT_TERMINALS`                | `24`       |
| `MEND_BUDGET_ACCOUNT_TUNNELS`                  | `24`       |
| `MEND_BUDGET_ACCOUNT_KEY_BRIDGES`              | `4`        |

## Slack

A Slack app's tokens are stored per organization when an owner connects it, not in the environment.
See [Slack](/integrations/slack/).

| Variable                         | Default | What it does                                                                                                                                                         |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEND_SLACK_EVENTS_PER_MINUTE`   | `120`   | Events one Slack app may deliver per minute, per worker process. `0` turns the limit off.                                                                            |
| `MEND_SLACK_INFERENCES_PER_HOUR` | `60`    | Thread readings one organization may run per hour, per worker process. Past it, Mend picks the project from the defaults without inference. `0` turns the limit off. |

## Inference

Mend uses inference on the connected accounts of the person it works for, through Sealant. It ships
no model keys.

| Variable                             | Default            | What it does                                                                      |
| ------------------------------------ | ------------------ | --------------------------------------------------------------------------------- |
| `MEND_INFERENCE_CLAUDE_ACCOUNT`      | unset              | The connected Claude account inference uses. Unset, the person's default account. |
| `MEND_INFERENCE_CODEX_ACCOUNT`       | unset              | The same for Codex.                                                               |
| `MEND_INFERENCE_NAMING_MODEL_CLAUDE` | `claude-haiku-4-5` | The model that names sessions, on a Claude account.                               |
| `MEND_INFERENCE_NAMING_MODEL_CODEX`  | `gpt-5.6-luna`     | The same, on a Codex account.                                                     |
| `MEND_INFERENCE_INTENT_MODEL_CLAUDE` | `claude-haiku-4-5` | The model that reads whether a request asked for a change, for automatic landing. |
| `MEND_INFERENCE_INTENT_MODEL_CODEX`  | `gpt-5.6-luna`     | The same, on a Codex account.                                                     |
| `MEND_INFERENCE_SLACK_MODEL_CLAUDE`  | `claude-haiku-4-5` | The model that reads a Slack thread for its project and intent.                   |
| `MEND_INFERENCE_SLACK_MODEL_CODEX`   | `gpt-5.6-luna`     | The same, on a Codex account.                                                     |

## Set them on the Docker install

`mend server setup` takes no environment variables. It writes the installation's `server.env`
itself, from its flags and the secrets it generates, and every later command checks that file
against the saved configuration: a hand edit makes the next command refuse with
`Server secrets are corrupt: server.env does not match the persisted server config and identity.`
The compose file also names each variable the Mend container receives, so a new line in `.env`
reaches nothing on its own.

What `server.env` holds, all read by the compose file:

| Variable                                                                                                                                                                         | Set from                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `MEND_VERSION`, `MEND_IMAGE_REPOSITORY`                                                                                                                                          | `--version`; `ghcr.io/sealant-sh/mend`                           |
| `APP_URL`, `MEND_ALLOWED_ORIGINS`                                                                                                                                                | `--url`, `--origin`                                              |
| `MEND_BIND_HOST`, `MEND_PORT`, `MEND_SSH_PORT`                                                                                                                                   | `--bind` (`127.0.0.1`), `--port` (`3105`), `--ssh-port` (`2222`) |
| `SEALANT_SSH_HOST`                                                                                                                                                               | the host name in `--url`                                         |
| `DOCKER_SOCKET_PATH`                                                                                                                                                             | detected, or `--docker-socket`                                   |
| `MEND_POSTGRES_ADMIN_PASSWORD`, `MEND_DB_PASSWORD`, `SEALANT_DB_PASSWORD`, `BETTER_AUTH_SECRET`, `SEALANT_CREDENTIALS_KEY`, `SEALANT_SERVICE_KEY`, `WORKSPACE_SSH_GATEWAY_TOKEN` | generated once, kept in the installation's identity              |
| `MEND_GARAGE_RPC_SECRET`, `MEND_GARAGE_ADMIN_TOKEN`, `MEND_GARAGE_KEY_ID`, `MEND_GARAGE_KEY_SECRET`                                                                              | derived from the identity                                        |
| `MEND_STORE_VOLUME_NAME`, `MEND_CONTROL_VOLUME_NAME`, `MEND_GARAGE_VOLUME_NAME`                                                                                                  | the fixed volume names                                           |

Inside the Mend container, a supervisor starts the Mend API and web tier and the pinned Sealant
processes. It sets these for the Mend API itself, whatever the container received: `PORT=3101`,
`MEND_MODE=all`, `MEND_STORE_ROOT=/var/lib/mend/store`, `MEND_EXECUTOR_NETWORK=private` (the Compose
network never leaves the host), `SEALANT_BASE_URL=http://127.0.0.1:4000`, and `DATABASE_URL`,
`SEALANT_SERVICE_KEY`, `APP_URL` and `BETTER_AUTH_SECRET` from the container's own values. Every
other variable the container receives passes through to the API.

So on the Docker install made by `mend server setup`, every other variable on this page keeps its
default, `MEND_EXPOSURE=private` included. To set one, run the Compose project yourself from the
release's `compose.v2.yaml` and an `.env` holding the values it names
(`deploy/docker/bundle.env.example` lists them), and add the variable to the `mend` service in an
override file:

```yaml
# compose.override.yaml
services:
  mend:
    environment:
      MEND_SOURCE_POLICY: tenant
      MEND_DATABASE_POOL_MAX: "4"
```

```sh
docker compose -f compose.v2.yaml -f compose.override.yaml up -d
```

A project you run this way is yours to operate: `mend server start`, `restart` and `upgrade` run the
installation's saved `compose.yaml` alone. The
[Caddy edge](/operate/exposure/#a-caddy-edge-for-a-compose-install-you-run-yourself) overlay is the
same kind of override.

## Set them on Kubernetes

The chart (`deploy/helm/mend`) sets the variables it owns from its values:

| Value                                             | Variable                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `web.appUrl`, `web.allowedOrigins`                | `APP_URL`, `MEND_ALLOWED_ORIGINS` (both tiers)                                                          |
| `api.trustedProxyCidrs`                           | `MEND_TRUSTED_PROXIES`                                                                                  |
| `sealant.baseUrl`                                 | `SEALANT_BASE_URL`                                                                                      |
| `secrets.existingSecret`                          | `BETTER_AUTH_SECRET`, `SEALANT_SERVICE_KEY`, and `DATABASE_URL` or `MEND_DB_PASSWORD`                   |
| `exposure.mode`                                   | `MEND_EXPOSURE`                                                                                         |
| `exposure.executorNetwork`                        | `MEND_EXECUTOR_NETWORK`                                                                                 |
| `exposure.declared`                               | `MEND_EXPOSURE_DECLARED`                                                                                |
| `exposure.refuseUrlBearers`                       | `MEND_URL_BEARERS=refuse`                                                                               |
| `exposure.reassessedVersion`                      | `MEND_EXPOSURE_REASSESSED`                                                                              |
| `serviceHost.bindAddresses`, `portMin`, `portMax` | `MEND_SERVICE_HOSTS`, `MEND_SERVICE_PORT_MIN`, `MEND_SERVICE_PORT_MAX`                                  |
| `sessionChannel.*`                                | `MEND_SESSION_ENDPOINT_LISTEN`, `_URL`, `_TLS_CERT`, `_TLS_KEY`, `_CA_FILE`                             |
| `captureStore.blobStore.*`                        | `MEND_BLOB_STORE`, `MEND_BLOB_STORE_PUBLIC_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`           |
| `captureStore.multipart.*`, `byteQuotaFloorBytes` | `MEND_CAPTURE_MULTIPART_THRESHOLD`, `MEND_CAPTURE_MULTIPART_PART_SIZE`, `MEND_CAPTURE_BYTE_QUOTA_FLOOR` |

It also sets `MEND_DEPLOYMENT_MODE=kubernetes`, `MEND_MODE=all`, `MEND_SESSION_STORE=captured`,
`MEND_STORE_ROOT`, `MEND_KEYS_ROOT` and `MEND_VERSION`.

Everything else goes in `extraEnv`, as plain name and value pairs. They reach the API tier only,
never the web tier:

```yaml
extraEnv:
  - { name: MEND_SOURCE_POLICY, value: tenant }
  - { name: MEND_CAPTURE_REQUIRE_SIZES, value: "true" }
  - { name: MEND_BUDGET_ACCOUNT_LIVE_SESSIONS, value: "12" }
```

Use `extraEnv` for the variables the chart does not set, and the value that maps to a variable for
the ones it does. See [Deploy on Kubernetes](/operate/deploy-kubernetes/).
