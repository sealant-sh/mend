# Desktop pilot experiment

This branch prototypes coding agents and optional desktop pilots sharing an X11 desktop with a
human. It is a development experiment, not part of the current release. The normal Mend server does
not create containers through Docker: session desktops start as Services through the public Sealant
SDK. The standalone Docker fixture below is for local acceptance testing only.

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

## Real Mend sessions

Build the amd64 image on the Sealant Docker executor:

```sh
docker build --platform linux/amd64 -f deploy/desktop/Dockerfile -t mend-desktop:pilot-v4 .
```

In a project's **Setup → Environment**, choose **Use desktop image** and save. Start a normal Claude
or Codex session using your connected account. In its session page, **Start desktop** runs
`/opt/mend-desktop/start` through Mend's existing recorded Service API. Both the coding agent and
the pilot work in that session's container. The goal can point at a development server the coding
agent started, a local file in its worktree, or an external website.

The embedded noVNC code is bundled with Mend. Its WebSocket carries VNC bytes through the public
SDK's workspace forward; the HTTP bridge admits only controller operations and the four artifact
files. Both require Mend sign-in and the session owner. The existing origin policy, socket
revocation, frame limits and connection budgets apply. No workspace HTML or JavaScript is served on
Mend's origin. The normal raw Service listener is still separate and reports its own access.

Recordings and observations live under the session's captured harness home:

- Shared layout: `/workspace/harness-home/.mend/desktop/<session>/runs/`.
- Person layout: `/workspace/harness-home/people/<owner>/desktop/<session>/runs/`.

After the desktop or workspace stops, the same links stream files from the capture store, including
HTTP byte ranges for video seeking. The panel names the capture it read. A running pilot in an older
capture is reported as interrupted. **Restart desktop** restores live control in a live workspace.

Mend puts the chosen owner's connected login into a separate credentials home in the live executor
through Core's public SDK; the coding agent's login home is unchanged. Each pilot uses another
private temporary native agent home, copying only that chosen login. This keeps its native
conversation out of the parent session's transcript harvest. That home is removed when the pilot
finishes; the controller's transcript and observations remain captured.

## Limits before a release

Claude and Codex terminal sessions receive the image's desktop MCP tools at launch, including
recording controls and both execution styles. The image's skill is linked from Mend's managed
workspace note. A first tool call starts the desktop through `mend service run`; recording and
manual takeover work through the same controller as the optional separate pilot. Takeover ends
terminal-driven recording and aborts desktop code; the coding agent stays running.

The optional pilot remains a separate CLI conversation. Its temporary login copy is not written back
into Core. Terminal tools use the coding agent's own login and conversation. Only the owner can view
or steer the desktop. One desktop service can own the display in a workspace at a time. An
already-running native agent must be relaunched to load newly registered MCP tools.

Human view-only mode is a viewer convention. The authorized owner can send VNC input directly. Code
mode is not a JavaScript security sandbox; Codex's tool restriction is a prompt instruction. The
disposable container is the boundary. Chromium runs without its own sandbox inside it. The
standalone fixture's controller has no Mend sign-in and should stay on loopback.

When updating a mutable local image that Core has already compiled, use a new image tag so the
workspace build uses the new revision. Setup commands run after provisioning and do not invalidate a
compiled custom base. The preset verifies the pilot home module before launch.

## Checks

Terminal acceptance also used real Claude and Codex PTY sessions. Codex created and served its page,
then used its own desktop MCP tools to reach Count: 5 / Hello, Mend! in three calls. Claude used
seven screenshot actions on the bundled demo, reached Count: 2 and reported that its greeting
omitted the expected exclamation mark. Both finished recording in the same native coding
conversation. Manual takeover aborted an active terminal desktop code worker and left the primary
coding process alive.

Local acceptance used the built web app and a real captured session. The coding agent created a
counter page in its worktree. Codex code mode reached Count: 5 / Hello, Mend! in four calls; Claude
action mode reached Count: 3 / Hello, Claude! in eight calls. Manual takeover cancelled a running
pilot and accepted VNC input while the parent coding agent stayed alive. A separate stopped session
replayed its saved MP4 with byte-range seeking from the capture store.

```sh
node --test deploy/desktop/control.test.mjs deploy/desktop/pilot-home.test.mjs
pnpm --filter @mend/api-server test src/routes/desktop-http.test.ts src/routes/desktop-capture.test.ts
pnpm --filter @mend/web test src/lib/workspace-environment.test.ts
pnpm exec turbo typecheck --force
pnpm exec turbo lint --force
```
