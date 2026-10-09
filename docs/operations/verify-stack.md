# The verify stack

A full Mend stack built from source inside one Mend session: sealantd, Sealant Core (API, worker,
SSH gateway) and Mend, each at a ref you name, installed with the product's own `mend server setup`.
It exists so a verifier (pstack's `verify` skill, or you) can drive a change that spans the three
repositories as one stack, keep the evidence and tear it down. Everything runs in the session's own
Docker service, so the stack is gone with the session's workspace.

The script is `scripts/verify-stack/stack.mjs`; `mend.toml` declares it as the `stack` Service.

## Start it

From a Mend session of the `mend` project, with the project's Docker service on (the default):

```sh
mend service stack                 # the recipe in mend.toml
```

or, with refs, as a Service of your own:

```sh
mend service run --port 3305 --http --name stack -- \
  node scripts/verify-stack/stack.mjs serve --sealant '#345' --sealantd pr:152
```

`serve` builds, installs, runs the check below, then holds while the Service runs. Stopping the
Service (`mend service stop stack`, the web's Stop) removes the stack and keeps its images, so the
next start reuses every image whose source did not change. `up` does the same without holding, and
`down` removes it.

On your machine, bring the web here and open it:

```sh
mend service connect stack --port 3305     # then http://localhost:3305
```

The port matters: the inner server's origin is `http://localhost:3305`, and a sign-in from any other
origin is refused. To sign in, ask the stack for an invitation and open it:

```sh
node scripts/verify-stack/stack.mjs mend invite --role owner --days 1
```

## Sources

Each repository takes one of:

| Spec                 | Builds                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------- |
| a path (`.`, `/…`)   | that working tree as it is: tracked files, plus untracked ones `git` does not ignore      |
| `#123` or `pr:123`   | the pull request's head on GitHub                                                         |
| a branch, tag or sha | that commit on GitHub                                                                     |
| `pinned`             | nothing: Core and sealantd as this Mend commit pins them (`--sealant`, `--sealantd` only) |

The defaults are this checkout for Mend, and `/workspace/repos/sealant` and
`/workspace/repos/sealantd` when `mend repo add` brought them into the session (ADR 0011), else
`main`. So to verify a change across the three repositories, add the other two to the session, check
out the branches there, and start the Service: every repository builds as its working tree.

Refs are fetched anonymously from `github.com/sealant-sh/*` (all three are public) into a bare
cache, one commit deep. A working tree is read through a private index: your index, branch and files
are not touched.

## What it does

1. Resolves each source to a commit and a tree, and writes each tree out once as a build context.
2. Builds the images, all at once: `docker/Dockerfile` of sealantd; `apps/{api,worker,ssh-gateway}`
   of Core; Mend's root `Dockerfile` with the build arguments `preview.yml` passes
   (`SEALANT_*_IMAGE`, `MEND_PREVIEW_SEALANTD_IMAGE`) once Core's three exist; and the inner CLI,
   the `@sealant/mend` package packed from the same Mend source and installed with npm. An image
   whose tree this daemon built before is reused. Mend's version is its CLI version marked
   `-verify.t<digest>`, which no release carries.
3. Runs `mend server setup --offline` with that version, from the inner CLI's container.
4. Starts a relay that publishes the web where the session reaches the daemon, creates the first
   account (its password and token stay in a Docker volume), and adopts `verify-fixture`, a
   one-commit repository served on the stack's network, whose sessions run on `node:26-bookworm`
   with no Docker service.
5. Checks: an inner `mend run -- true`, until its session settles `completed`.

`mend <args…>` runs the inner CLI signed in as the first account, so anything the product does works
against the stack: `mend adopt https://github.com/sealant-sh/mend.git`, `mend run`,
`mend sessions --all`, `mend server status`.

## Evidence

```sh
node scripts/verify-stack/stack.mjs report          # or --json
```

prints the sources (ref, commit, tree), the time of every phase, the check's outcome, the memory of
every process in the session's Docker daemon (PSS, largest first), and the isolation check below.
Build logs are under `~/.cache/mend-verify-stack/logs/<run>/`.

## Measured

Locally, in a session of a Mend 0.36.0-next.658 server in Docker-in-Docker, per-person layout, the
session's Docker service capped at 12 CPUs; Core, sealantd at main, Mend at this branch:

| Phase                                    | Time                                       |
| ---------------------------------------- | ------------------------------------------ |
| cold start to ready (empty Docker cache) | 3 min 3 s                                  |
| sealantd (cargo, the critical path)      | 1 min 25 s – 1 min 40 s                    |
| Core's three images, in parallel         | 50–54 s                                    |
| Mend bundle, after Core                  | 21–35 s                                    |
| `mend server setup`                      | 13–19 s                                    |
| start again, every image reused          | 20 s                                       |
| the check, first / later                 | 23–30 s (builds the workspace image) / 8 s |

| Memory                                         |                                               |
| ---------------------------------------------- | --------------------------------------------- |
| idle, every process of the daemon (PSS)        | 2.1 GiB (dockerd ≈ 0.9 GiB of it)             |
| the session's Docker service, as Docker counts | 2.6–3.1 GiB idle, 8.5 GiB peak while building |
| the session's own workspace                    | 0.6 GiB                                       |

## Security

- The inner server's secrets (its Sealant service key, auth secret, database and Garage credentials)
  are generated by `mend server setup` inside a container and live in the Docker volume
  `mend-verify-stack-state`. The first account's password and token are written there over stdin.
  None of it is in argv, a log, or a capture root.
- Docker clients run with an environment of their own (`dockerClientEnvironment`): `PATH`,
  `DOCKER_HOST`, a private `HOME` and `DOCKER_CONFIG`. No `MEND_*` variable of the session reaches
  them, so no container of the stack holds a credential of the outer server. `report` checks every
  container's environment, command and labels for the session's token and names any place it finds
  one, never the value.
- The stack's files (contexts, bare repositories, logs, the state file) are under
  `~/.cache/mend-verify-stack`, which is in the session's home and outside every capture root; the
  script refuses a cache inside `/workspace`.
- The relay publishes on every interface of the session's Docker service only, which is reached on a
  network only the session's workspace shares. On any other daemon it publishes on loopback.

## Limits

- One stack per Docker daemon: the inner server uses the product's own names (Compose project
  `mend`, volumes `mend-store`, `mend-control`, `mend-garage`). On a daemon that already runs a Mend
  server the script refuses to start.
- The fixture's sessions run without a Docker service: a Docker daemon inside the session's own
  rootless one was not tried.
- Mend's image installs `@sealant/sdk` and `@sealant/api-contracts` from npm at the version Mend
  pins, and Core's images install `@sealant/runtime-*` from npm, as a preview build does
  ([Preview builds](preview-builds.md), "Limits").
- A session's workspace image has the Docker CLI and Compose but no buildx; the script copies the
  plugin out of `docker:27.5.1-cli` into its own Docker configuration.
- Images are pulled anonymously; until the server's mirrors exist, a cold start pulls `rust`,
  `node`, `alpine`, `postgres`, `garage` and `docker` images from Docker Hub.
