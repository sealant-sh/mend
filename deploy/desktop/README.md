# Desktop pilot experiment

This branch prototypes a dedicated computer-use agent sharing an X11 desktop with a human. It is a
development experiment, not part of the current release. The normal Mend server does not create
containers through Docker: session desktops start as Services through the public Sealant SDK. The
standalone Docker fixture below is for local acceptance testing only.

## Run locally

```sh
pnpm install --frozen-lockfile
node scripts/desktop-preview.mjs start --build
MEND_DESKTOP_PREVIEW_URL=http://127.0.0.1:6090 pnpm --filter @mend/web dev
```

Open <http://127.0.0.1:3105/desktop-experiment>. The preview binds to loopback when enabled. The
fixture reads existing Claude Code and Codex sign-in files through read-only mounts; it does not
copy the host home directory. Sign in with the chosen CLI before starting it. An existing fixture
container is reused; recreate that named fixture after changing mount options.

The web view provides live pixels, agent/model/goal selection, two execution styles, cancellation,
manual takeover, and recorded observations. `http://127.0.0.1:6090/demo` is a real browser test
application with a counter and greeting. Arbitrary HTTP(S) sites can also be opened.

- **Actions:** screenshot, click, type, key, scroll, open_browser. Each tool returns a screenshot.
- **Code:** screenshot and execute. Generated JavaScript calls `desktop.click(x, y)`,
  `desktop.type(text)`, `desktop.key(chord)`, `desktop.scroll(direction, amount)`,
  `desktop.openBrowser(url)`, `desktop.screenshot()` and `desktop.wait(milliseconds)`. A screenshot
  returns after each batch. Generated code runs inside the disposable workspace.
- Each pilot has a five-minute deadline. Taking control stops its inference process and active code
  worker. Release control before starting another pilot.
- FFmpeg captures the same display at 1440×900/12fps to H.264 MP4. Each run retains its final PNG,
  timestamped tool calls, result, and transcript. Preview artifacts persist under
  `~/.local/share/mend/desktop-preview/runs/` and remain available after container restarts.

Stop only this fixture with `node scripts/desktop-preview.mjs stop`.

## Session integration scaffold

The development environment editor offers the `mend-desktop:local` custom-image preset. Build that
amd64 image on the Sealant executor before selecting it. A live session using it offers **Start
desktop**, which calls Mend's existing recorded Service API for `/opt/mend-desktop/start` on
port 6090. Its workspace must have the chosen harness credentials. This path has not yet been
exercised against a live Sealant executor.

## Limits before a release

The pilot is a separate CLI conversation; its tool calls and recordings are not yet linked to a Mend
session's durable record or capture store. The controller port has no Mend sign-in: use only
loopback or a private forwarded Service. Human view-only mode is a viewer convention, not a
server-side input authorization boundary. Code mode is not a JavaScript security sandbox; Codex's
tool restriction is a prompt instruction. The disposable container is the boundary. Chromium runs
without its own sandbox inside that container.

Authenticated same-origin HTTP/WebSocket forwarding is needed before production session embeds (the
production CSP intentionally blocks separate-port embeds). The session panel and image preset are
therefore development-only. Credential refresh, desktop process lifecycle across workspace restarts,
durable artifacts, shared-control authorization and parent/pilot handoff remain follow-up work.

## Checks

```sh
node --test deploy/desktop/control.test.mjs
pnpm --filter @mend/web test src/lib/workspace-environment.test.ts
pnpm exec turbo typecheck --force
pnpm exec turbo lint --force
```
