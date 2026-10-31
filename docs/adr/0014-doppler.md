# Doppler: a person's token and project selections in their own workspace home

Accepted by Yiannis, 2026-10-31, for Mend 0.37. This replaces the heavier proposal on
[the original ADR branch, #501](https://github.com/sealant-sh/mend/pull/501). That PR is left
untouched. The decisions here follow [secret files, ADR 0010](0010-secret-files.md) and
[per-person homes, ADR 0016](0016-per-person-harness-homes.md).

Mend carries a person's Doppler login into their workspace so their agent and application can use
the real Doppler CLI. Mend stores a token and selections, and never downloads or caches the
project's secrets. A broken Doppler connection must not prevent a session from starting.

## Connection and selections

Each person has at most one Doppler connection. They may supply a personal CLI token, a personal
token or a service token. Mend checks only basic transport validity: a nonempty token of at most
8192 characters, without whitespace or control characters. It does not police token kinds or call
Doppler to validate a save. A service token can have narrower permissions than the project picker
needs; selecting known project/config names still works.

The token is write-only. The API never returns it, including in status, errors or diagnostics. Mend
encrypts it with the same `SecretCipher` and machine key as secret files. Database reads and writes
always name the authenticated person or the person whose process is starting. Disconnect removes
that person's connection and all their selections. Account deletion cascades both.

A selection belongs to one person and one Mend project. It holds a Doppler project and config name.
Two people working on the same Mend project can select different configs. Project access still
applies to listing and changing selections; an organization owner has no route to another person's
token or selections. There is no organization-wide Doppler token.

The authenticated HTTP group is `doppler`, under `/me/doppler`. It exposes status, save, disconnect,
mapping upsert/removal, and project/config picker endpoints. The picker proxies Doppler with the
caller's saved token and sanitized errors. Only these explicit picker requests contact Doppler.
Connection names remain `null` in this first implementation; save does not make a token-info
request. The picker returns the first 100 choices, while explicit names remain available through
`mend doppler use`.

## Delivery and whose login runs

At the existing secret-file delivery step, Mend unseals the launching person's token and builds
`~/.doppler/.doppler.yaml` in that person's own, uncaptured Linux home, as that Linux user. It uses
the existing one-use secret-file pickup channel, bound to session, launch and person. The platform's
durable exec argv carries a pickup ticket and paths, never the token or file bytes. Files are staged
and renamed with mode 0600, under directories made with mode 0700. The existing plain-path checks
refuse symlinks and paths into captured directories. Neither worktree nor harness-home captures
include this file. A saved generic secret file at the same path is replaced by the generated Doppler
file while the person has a Doppler connection.

The actual CLI config has `scoped` entries. The token is scoped to `/`; the selection is scoped to
the worktree, using Doppler's dotted keys:

```yaml
scoped:
  /:
    token: <personal token, never displayed by Mend>
  /workspace/repo:
    enclave.project: backend
    enclave.config: dev_yiannis
```

The format was checked against DopplerHQ/cli `pkg/models/config.go` at
[`236908d5`](https://github.com/DopplerHQ/cli/blob/236908d5f8d27da251479bfad05e6bb243339208/pkg/models/config.go).
A real Doppler 3.77.1 binary reads project, config and a fake token from a temporary config
directory in the offline test. JSON is valid YAML, so Mend writes JSON with these exact keys.

Delivery follows the existing personal execution paths. A shared-control conversation turn runs as
its sender and receives that sender's Doppler file. Joined sessions use their own person's home.
Services and previews run as their last starter, including automatic restarts, and read that
starter's file. Nothing swaps the token under another person's live process. In a legacy executor
that shares one home, ADR 0016's owner rule still applies: delivery uses the workspace owner's
connection, and a joiner does not overwrite that home with their own credentials.

Launch makes no Doppler network request and does not require the Doppler binary. Delivery is
best-effort like other secret files. A missing CLI, an unavailable Doppler service or a bad token
does not stop the agent; a later `doppler run` reports its own result. A saved connection or mapping
change reaches other homes at their next secret-file delivery, rather than changing a running
process's environment.

## CLI import and changes in a live workspace

`mend doppler connect` imports the person's existing local login after `doppler login`, on a laptop
or inside a session. It prefers `doppler configure --all --json --no-check-version` because Doppler
resolves keyring-backed `secret-…` references there. A raw local-file import must never upload an
unresolved keyring reference. The laptop CLI can read ordinary YAML without Doppler; the standalone
workspace helper can read Mend's generated JSON when the binary is absent. Token output stays in
memory and is never printed. Directory scopes map to adopted Mend projects through Git remotes, not
laptop paths. Every imported mapping is printed as a Mend project name and Doppler project/config,
followed by the count.

`mend doppler use <doppler-project> <config> [--project <mend-project>]` saves the person's
selection. It defaults to the session's project inside a workspace and to the current repository on
a laptop. For the current session project, the helper rewrites the person's live local file
immediately. `status` prints connection information and selections; inside a workspace it also says
when the Doppler CLI is not installed.

`disconnect` deletes the server token and selections. The workspace helper also removes its own
unchanged Mend-delivered file. Generated files carry a `mend-delivery` digest of their scoped
contents; `use` updates it. A later local login or manual edit invalidates or removes the stamp, so
disconnect preserves that file. The sealed secret-file delivery record still limits later server
cleanup to a path Mend previously delivered. A laptop disconnect preserves the laptop's Doppler
login.

No device-login flow is required for this PR. Optional device login is tracked in
[#1288](https://github.com/sealant-sh/mend/issues/1288).

## Workspace images

Every workspace image request appends catalog package `doppler`, alongside its existing packages.
The same `packages: ["doppler"]` spelling works for managed image families and custom bases through
Core's `customRelease` catalog support. [Core #428](https://github.com/sealant-sh/sealant/pull/428)
pins the CLI to 3.77.1. This PR also updates Mend's SDK and Core image pins to the published Core
`-next` release containing that change. Kubernetes cross-node Remote I/O behavior reproduces on Core
main and is outside this Doppler change.
