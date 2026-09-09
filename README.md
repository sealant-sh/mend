# Mend

**Code is now cheap. Trust is not.**

Mend, by [Sealant](https://github.com/sealant-sh/sealant), is for developers who run coding agents
heavily and work from more than one device. It co-locates agent sessions, their git worktrees, and
the project context they run with in one self-hostable environment, and makes working there feel
like real local development from whichever device you pick up. The work stops scattering across
terminals, provider apps, and browser tabs.

```text
mend codex → recorded session in a store worktree → local review with provenance → follow-up → commit or PR
```

Inside an adopted repository, `mend codex`, `mend claude`, or `mend run -- <cmd>` starts the agent
the way it always started: a real terminal, a real git worktree. What changes is where everything
lives. The session runs under Sealant supervision on the Mend machine, next to the worktree it edits
and the context it launched with: repository instructions, environment and secrets, mounted
references, your accounts and dotfiles. Close the terminal and the agent keeps working. Come back
from the CLI, a browser, the desktop app, or a phone on your tailnet, and the same session picks up
where it was.

Review the accumulated change in the same place. Every hunk in the diff can answer "why did this
change?" from the recording, comments go back to the same session as an editable follow-up, and
"Mend read this change" drafts evidence-linked findings a diff-only reviewer cannot make. No issue
tracker, no pull request required; publication is optional output, not the point.

Mend is open-source, self-hosted, and built on the public
[`@sealant/sdk`](https://www.npmjs.com/package/@sealant/sdk), with no private hooks into the Sealant
runtime underneath. [`MEND-AGENT-WORKBENCH-PLAN.md`](MEND-AGENT-WORKBENCH-PLAN.md) is the canonical
product direction and carries the decision log.

## Install

Install the CLI with Node.js 22 or newer:

```sh
npm install --global @sealant/mend
# Or: curl -fsSL https://mend.sealant.dev/install.sh | sh
```

Both methods install **only the CLI**. They do not install Docker, create a server, or start
services. The optional terminal dashboard requires Node.js 26; other commands work on Node.js 22.

On the machine that will hold your projects, install a current Docker Engine or Docker Desktop with
Compose v2, then explicitly set up the server:

```sh
mend server setup
```

At idle there are two containers: the complete Mend application and official Postgres. Sealant is
pinned inside the application image; you manage the Mend version, not a separate platform version.
Session workspaces may create additional containers while work is running. Repositories, worktrees,
harness state, database data, and SSH identity live in Docker-managed volumes.

Open `http://localhost:3105`, create an account, then:

```sh
mend login --url http://localhost:3105
mend connect codex                 # or claude; connect github for private repositories
mend adopt https://github.com/your-org/your-repo.git --name demo
mend codex --project demo
```

Adoption takes a Git repository URL, not a local folder or a server filesystem path. An existing
checkout can still identify an already-adopted project when you run a command from it.

Setup reruns preserve the server pin, secrets, and data. Updating the npm CLI does not upgrade the
server. Use `mend server upgrade --version VERSION` when you choose to change it. See
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) for lifecycle commands, offline setup, and recovery.

## Connect from another device

The server binds to localhost by default. Private-network access is explicit; for example, on a Mac
Mini or home server reachable as `mac-mini.local`:

```sh
mend server setup --bind 0.0.0.0 --url http://mac-mini.local:3105 \
  --origin http://localhost:3105
```

Keep the host behind a private network or firewall. Binding `0.0.0.0` exposes web and SSH on every
IPv4 interface; it does not configure Tailscale or a firewall for you. Sign-up remains open to
anyone who can reach Mend. Only web and SSH are published; Postgres has no published port.

On your laptop, install just the CLI and run `mend login --url http://mac-mini.local:3105`.
`mend connect` reads credentials from that laptop, not the server. `mend pair` offers only
configured server URLs. The native mobile app is unpublished; build it yourself or use the browser.

The VS Code extension opens session workspaces through Remote-SSH, using the configured Mend URL's
hostname and the advertised SSH port. It maintains a separate SSH alias for each server, with your
consent. See [`docs/WORKSPACE-SSH.md`](docs/WORKSPACE-SSH.md).

Physical macOS and installed VS Code acceptance are tracked in
[`docs/MACOS-VALIDATION.md`](docs/MACOS-VALIDATION.md). Linux container tests are not evidence that
MacBook-to-Mac-Mini operation has been verified.

`mend server setup` currently targets Docker. Kubernetes setup is later work; the existing
[`deploy/helm/mend`](deploy/helm/mend) chart and [`docs/KUBERNETES.md`](docs/KUBERNETES.md) remain
an operator-managed deployment path, not part of this installer.

## Status

In development. The server, CLI, web app, desktop app, VS Code extension, documentation site, and
Kubernetes charts exist in the repository; the native mobile app is unpublished. The documentation
site's feature-status page separates current behavior from planned work. Treat plan milestones as
direction, not release status.

## Monorepo

- `apps/api`: the Mend API server (contract, auth, session engine, workers)
- `apps/cli`: the `mend` CLI
- `apps/web`: the product app, Now · projects · sessions · review
- `apps/desktop`: the Electron workbench
- `apps/mobile`: the Expo native app (unpublished)
- `apps/vscode`: the VS Code extension
- `apps/docs`: the documentation site (Astro Starlight)
- `apps/marketing`: the public site (TanStack Start on Cloudflare Workers)
- `packages/*`: shared libraries (`domain`, `db`, `api-contracts`, `sessions`, `store`, `ui`, …)
- `deploy/helm/mend`: the Helm chart
- `tooling/typescript`: shared tsconfig bases

```sh
pnpm install
pnpm dev                         # product web app
pnpm --filter @mend/docs dev     # documentation site on port 3103
pnpm typecheck                   # tsgo, never tsc
pnpm lint
pnpm format:fix
```

## Acknowledgments

Mend borrows deliberately from projects that solved hard problems well. Vendored code keeps its
upstream license and notices next to it.

- [t3code](https://github.com/pingdotgg/t3code) (T3 Tools Inc., MIT) is the project we've taken the
  most from:
  - `apps/mobile/modules/t3-terminal` vendors their native terminal module (libghostty on iOS via
    `GhosttyKit.xcframework`, `libghostty-vt` over JNI on Android); notices in that directory.
  - `apps/desktop/src/renderer/src/terminal/ghostty` adapts their browser terminal, the official
    `libghostty-vt` C ABI compiled to wasm with their own renderer and input surface; notices in
    that directory.
  - The desktop inbox re-implements their sidebar model: static creation order (activity never
    reorders), attention carried by contrast, client-local unseen state, lifecycle shelves, held-
    modifier jump hints.
  - The terminal reconnect discipline (fixed ladder, reset-once-stable, retry on focus), the mobile
    chat list's pinned-follow scrolling, PTY frame coalescing, and the notification suppression
    guards were studied in their source and re-implemented here.
- [Ghostty](https://github.com/ghostty-org/ghostty) (Mitchell Hashimoto & contributors, MIT):
  `libghostty-vt` is the terminal core behind every Mend terminal surface, on all three platforms.
- [ghostty-web](https://github.com/coder/ghostty-web) (Coder, MIT): the wasm terminal used by
  `apps/web`.
- Symbols Nerd Font (Ryan L McIntyre, MIT): vendored with the desktop terminal so prompt glyphs
  render without a locally installed Nerd Font.

## License

Apache-2.0
