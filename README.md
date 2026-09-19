# Mend

Mend, by [Sealant](https://github.com/sealant-sh/sealant), is for developers who run coding agents
heavily and work from more than one device. It co-locates agent sessions, their git worktrees, and
the project context they run with in one self-hostable environment, and makes working there feel
like real local development from whichever device you pick up. The work stops scattering across
terminals, provider apps, and browser tabs.

```text
mend codex → recorded session in a store worktree → local review with provenance → follow-up → commit or PR
```

Inside an adopted repository, `mend codex`, `mend claude` or `mend run -- <cmd>` starts the agent
the way you always start it, in a terminal on a git worktree. It runs on the Mend machine under
Sealant supervision, in its own worktree, with the context it launched with: repository
instructions, environment and secrets, mounted references, your accounts and your dotfiles. Close
the terminal and the agent keeps working. Open the CLI, a browser, the desktop app or a phone later
and you are back in the same session.

You review the change on the same machine. Mend records the session, so for any hunk in the diff you
can ask why it changed and get the answer from the recording. Review comments go back to the same
session as a follow-up you can edit before sending. Mend can also read the change itself and draft
findings, each linked to the recording or shipped with a check you can run. None of this needs an
issue tracker or a pull request. Commit or open a PR when you want to.

Mend is open source and self-hosted. It uses Sealant only through the public
[`@sealant/sdk`](https://www.npmjs.com/package/@sealant/sdk), the same package anyone can install.
[`MEND-AGENT-WORKBENCH-PLAN.md`](MEND-AGENT-WORKBENCH-PLAN.md) holds the product direction and the
decision log.

## Install

Install the CLI with Node.js 22 or newer. The TUI, which is the dashboard `mend` opens in a
terminal, needs Node.js 26 or newer. Every other command works on Node.js 22.

```sh
npm install --global @sealant/mend
```

This installs the CLI and nothing else. It does not install Docker, create a server or start
services.

On the machine that will hold your projects, install a current Docker Engine or Docker Desktop with
Compose v2, then set up the server:

```sh
mend server setup
```

At idle there are three containers: the Mend application, Postgres, and Garage, which holds session
captures. Sealant is pinned inside the application image, so the only version you manage is Mend's.
Session workspaces may create more containers while work is running. Repositories, worktrees,
harness state, database data and the SSH identity live in Docker-managed volumes.

Open `http://localhost:3105` and create an account. The first account owns the instance and closes
registration. Everyone after that joins by invitation. Then:

```sh
mend login --url http://localhost:3105
mend connect codex                 # or claude; connect github for private repositories
mend adopt https://github.com/your-org/your-repo.git --name demo
mend codex --project demo
```

Adoption takes a Git repository URL. It does not take a local folder or a path on the server. If you
run a command from an existing checkout, Mend matches it to the project you already adopted.

Rerunning setup keeps the server pin, secrets and data. Updating the npm CLI does not upgrade the
server. Run `mend server upgrade --version VERSION` when you want to change it. See
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) for lifecycle commands, offline setup and recovery.

## Connect from another device

The server binds to localhost by default. To reach it from another device, give setup the address to
bind and the URL you will use. For a Mac Mini or home server reachable as `mac-mini.local`:

```sh
mend server setup --bind 0.0.0.0 --url http://mac-mini.local:3105 \
  --origin http://localhost:3105
```

Keep the host behind a private network or a firewall. Binding `0.0.0.0` exposes web and SSH on every
IPv4 interface. Mend does not configure Tailscale or a firewall for you. Setup publishes the web and
SSH ports only. Postgres has no published port.

On your laptop, install the CLI and run `mend login --url http://mac-mini.local:3105`.
`mend connect` reads credentials from that laptop, never from the server. `mend pair` offers only
the server URLs you configured. The native mobile app is unpublished, so build it yourself or use
the browser.

The VS Code extension opens session workspaces through Remote-SSH, using the hostname of the Mend
URL you configured and the SSH port the server advertises. With your consent it keeps one SSH alias
per server. See [`docs/WORKSPACE-SSH.md`](docs/WORKSPACE-SSH.md).

[`docs/MACOS-VALIDATION.md`](docs/MACOS-VALIDATION.md) tracks acceptance on physical macOS and with
an installed VS Code. Linux container tests say nothing about a MacBook talking to a Mac Mini.

`mend server setup` targets Docker and does not set up Kubernetes. The
[`deploy/helm/mend`](deploy/helm/mend) chart and [`docs/KUBERNETES.md`](docs/KUBERNETES.md) are for
operators who deploy it themselves.

## Status

In development. The server, CLI, web app, desktop app, VS Code extension, documentation site and
Kubernetes chart are in this repository. The native mobile app is unpublished. The documentation
site's feature-status page says what works today. Plan milestones describe direction.

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

Mend uses code and ideas from these projects. Vendored code keeps its upstream license and notices
next to it.

- [t3code](https://github.com/pingdotgg/t3code) (T3 Tools Inc., MIT) is the project we've taken the
  most from:
  - `apps/mobile/modules/t3-terminal` vendors their native terminal module: libghostty on iOS via
    `GhosttyKit.xcframework`, and `libghostty-vt` over JNI on Android. Notices are in that
    directory.
  - `apps/desktop/src/renderer/src/terminal/ghostty` adapts their browser terminal, which is the
    official `libghostty-vt` C ABI compiled to wasm with their own renderer and input handling.
    Notices are in that directory.
  - The desktop inbox re-implements their sidebar model: a static creation order that activity never
    reorders, attention carried by contrast, unseen state kept on the client, lifecycle shelves, and
    jump hints while a modifier is held.
  - We studied these in their source and re-implemented them here: the terminal reconnect rules
    (fixed ladder, reset once stable, retry on focus), the mobile chat list's pinned-follow
    scrolling, PTY frame coalescing, and the notification suppression guards.
- [Ghostty](https://github.com/ghostty-org/ghostty) (Mitchell Hashimoto & contributors, MIT):
  `libghostty-vt` is the terminal core behind every Mend terminal, on all three platforms.
- [ghostty-web](https://github.com/coder/ghostty-web) (Coder, MIT): the wasm terminal used by
  `apps/web`.
- Symbols Nerd Font (Ryan L McIntyre, MIT): vendored with the desktop terminal so prompt glyphs
  render without a locally installed Nerd Font.

## License

Apache-2.0
