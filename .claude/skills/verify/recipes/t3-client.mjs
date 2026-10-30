// The T3 gateway through a real t3code client (features/t3-gateway.md, "Through a t3code client"):
// the hosted web build of the pinned tag, paired with the run's gateway as a remote environment,
// driven the way a person uses it. Pair, launch a thread in a new worktree, a turn, a queue held by
// an interrupt and sent from with Send now (and Send now again from a second tab while that turn
// runs), snooze then settle, the terminal stopped and the page reloaded, the files and diff panels,
// the Files tab's previews of a worktree's raw files (an image, an SVG, an SVG with CRLF line ends
// that `.gitattributes` normalizes, a PDF, a video and its seeks, an HTML page and its stylesheet, a
// binary file), a checkpoint's earlier bytes, a gitignored file, a 300 MiB video and one over Mend's
// 2 GiB cap, a pasted chat image, and the minted asset URLs refused once the client's device is
// revoked in Mend's web.
//
//   node .claude/skills/verify/scripts/serve-t3-client.mjs --dist <t3code>/apps/web/dist \
//     --port <client port> --gw <gateway> &
//   node .claude/skills/verify/scripts/drive-web.mjs --web http://127.0.0.1:<client port> \
//     --out <dir> --private "$P" --recipe .claude/skills/verify/recipes/t3-client.mjs --timeout 60000
//
// Scratch projects only: MEND_VERIFY_T3_SCRATCH=owner runs creation, collisions, sessions and a
// path-shaped name, then makes a second member through Mend's invitation/sign-up boundary. Run
// MEND_VERIFY_T3_SCRATCH=member MEND_VERIFY_T3_ACCOUNT=scratch-member.json next: the browser pairs
// as that member and checks isolation and their own No project. Start owner on a fresh stack.
// Observed end states: 2026-10-30, features/t3-gateway.md, "Scratch projects and projects by name".
//
// Removal only: MEND_VERIFY_T3_REMOVAL=clean|no-origin|owner|live|project-blocked|project-remove|race.
// MEND_VERIFY_T3_REMOVAL_THREAD names a prepared thread; MEND_VERIFY_T3_REMOVAL_PROJECT names the
// project (default verify-fixture). See features/t3-gateway.md, "Worktree and project removal",
// for the real API fixture setup, account selection, CLI force and DELETE request trace.
// Observed end states: 2026-10-30.
//
// Retention: MEND_VERIFY_T3_RETENTION=absent|restored checks the project picker after a
// separate removal or restore. scratch removes No project and creates the next scratch;
// scratch-restore restores its predecessor under <name>-restored. The project/name selector is
// MEND_VERIFY_T3_RETENTION_PROJECT (verify-fixture by default; scratch-verifier for scratch-restore).
// See features/t3-gateway.md, "Restorable project removal", for web, CLI, disk and API steps.
// Observed end states: 2026-10-30.
//
// Needs the stack's account in $P/account.json (Launch, step 7) and a Claude login connected to the
// stack: the skill's fake one (`mend connect claude --from-stdin` with FAKES.claude), on which each
// turn starts and ends at once with Claude's own refusal. The browser starts empty: the client keeps
// its environments in IndexedDB, which --state does not carry, so the recipe pairs every run, and
// each run is a new `t3code · …` device in Mend. Previews read Mend's default captured store: the
// Files panel lists a file once a capture holding it is registered, so the recipe refreshes until
// it does. A file's first mint unpacks it on Mend, bounded at about ten seconds; past that the
// client shows it unavailable, and the recipe reopens it as a person would (Retry video, or a
// reload) until it previews. Fixtures are made here (ffmpeg on PATH for the MP4) and pasted into
// Mend's shell in the worktree; the large ones are written there by the shell. Revoking the device
// ends the run: every `t3code · T3 Code Web` device in Settings → Devices is revoked.
//
// Every `ok ·` line in steps.log is a step's observed end state; a line that does not hold fails
// the drive. `observed ·` lines record what was seen where the outcome is not fixed in advance
// (a race between two tabs, the client's own rendering). `rpc ·` lines are the client's own calls
// over /ws, read from its WebSocket frames: the gateway logs HTTP, not RPC. Mend's side is read
// through its API as the stack's account (`via api`), never acted on, except one checkpoint marked
// as setup for the checkpoint read. `window ·` lines bracket the opens and seeks that must reach
// Mend's disk cache only, for a process log of the inner Mend to be read against.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const P = process.env.MEND_VERIFY_PRIVATE;
const REFUSAL = "A queued user message can only be sent now while the thread is stopped.";
const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const HTML_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
const VERSION_ONE = "version one, at the checkpoint\n";
const VERSION_TWO = "version two, after the checkpoint\n";

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const record = JSON.parse(readFileSync(join(P, "t3-client.json"), "utf8"));
  const mend = record.web;
  const gateway = record.gateway;
  const account = JSON.parse(
    readFileSync(join(P, process.env.MEND_VERIFY_T3_ACCOUNT ?? "account.json"), "utf8"),
  );
  const { token } = account;
  const stamp = new Date().toISOString().slice(11, 19);

  const ok = (holds, text) => {
    if (!holds) throw new Error(`does not hold · ${text}`);
    note(`ok · ${text}`);
  };
  const api = async (path, init = {}) => {
    const res = await fetch(`${mend}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, origin: mend, ...init.headers },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const until = async (what, read, ms = 60_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`does not hold · ${what} within ${ms / 1000} s`);
      await page.waitForTimeout(1000);
    }
  };

  const rpc = {
    calls: new Map(),
    open: new Map(),
    failures: [],
    config: null,
    threads: new Map(),
    terminals: [],
    transcript: "",
    mints: [],
  };
  const watchSocket = (target, tab) =>
    target.on("websocket", (socket) => {
      if (!socket.url().startsWith(gateway.replace(/^http/, "ws"))) return;
      const parse = (payload) => {
        try {
          return JSON.parse(String(payload));
        } catch {
          return null;
        }
      };
      socket.on("framesent", ({ payload }) => {
        const frame = parse(payload);
        if (frame?._tag !== "Request") return;
        rpc.calls.set(`${tab}:${frame.id}`, frame.tag);
        rpc.open.set(`${tab}:${frame.id}`, frame.tag);
        if (frame.tag === "assets.createUrl") {
          const resource = frame.payload?.resource ?? {};
          const named = resource.absolutePath ?? resource.path ?? resource._tag ?? "";
          rpc.mints.push({
            key: `${tab}:${frame.id}`,
            name: String(named).split("/").at(-1),
            sentAt: Date.now(),
          });
        }
        if (frame.tag.startsWith("terminal."))
          rpc.terminals.push({
            tab,
            call: frame.tag,
            threadId: frame.payload?.threadId,
            resume: frame.payload?.resume ?? null,
            restartIfNotRunning: frame.payload?.restartIfNotRunning ?? null,
          });
      });
      socket.on("framereceived", ({ payload }) => {
        const frame = parse(payload);
        const tag = rpc.calls.get(`${tab}:${frame?.requestId}`);
        if (frame?._tag === "Exit") rpc.open.delete(`${tab}:${frame.requestId}`);
        if (tag === "assets.createUrl" && frame?._tag === "Exit") {
          const mint = rpc.mints.find((entry) => entry.key === `${tab}:${frame.requestId}`);
          if (mint !== undefined) {
            mint.ms = Date.now() - mint.sentAt;
            mint.ok = frame.exit?._tag === "Success";
            if (!mint.ok) mint.message = failureMessage(frame.exit?.cause);
          }
        }
        if (frame?._tag === "Exit" && frame.exit?._tag === "Failure")
          rpc.failures.push({ tab, tag, message: failureMessage(frame.exit.cause) });
        if (tag === "assets.createUrl" && frame?.exit?._tag === "Success") {
          const asset = assetOf(frame.exit.value.relativeUrl);
          if (asset !== null) minted.set(asset.name, `${gateway}${frame.exit.value.relativeUrl}`);
        }
        const values =
          frame?._tag === "Chunk"
            ? frame.values
            : frame?._tag === "Exit" && frame.exit?._tag === "Success"
              ? [frame.exit.value]
              : [];
        for (const value of values) {
          if (tag === "subscribeServerConfig" && value?.config) rpc.config = value.config;
          if (tag?.startsWith("terminal.") || tag === "subscribeTerminalMetadata")
            for (const { threadId, status, kind } of terminalStatesOf(value))
              rpc.terminals.push({ tab, call: tag, threadId, status, kind });
          if (tag === "terminal.attach" && value?.type === "output") rpc.transcript += value.data;
          collectThreads(value, rpc.threads);
        }
      });
    });
  watchSocket(page, "tab1");

  // Every asset URL the client fetched, and every one the gateway minted for it (by file name).
  // A token goes into the registry the moment it is seen; the log names `<token>` instead.
  const assets = [];
  const minted = new Map();
  const assetOf = (url) => {
    const match = /\/api\/assets\/(ast_[A-Za-z0-9_-]{43})\/([^?]*)/.exec(url);
    if (match === null) return null;
    registerSecret("t3-asset-token", match[1]);
    return { name: decodeURIComponent(match[2]) };
  };
  page.on("response", async (response) => {
    const asset = assetOf(response.url());
    if (asset === null) return;
    const headers = response.headers();
    const entry = {
      path: `/api/assets/<token>/${asset.name}`,
      range: (await response.request().allHeaders()).range ?? null,
      status: response.status(),
      contentType: headers["content-type"] ?? null,
      contentRange: headers["content-range"] ?? null,
      contentLength: headers["content-length"] ?? null,
      cacheControl: headers["cache-control"] ?? null,
      csp: headers["content-security-policy"] ?? null,
    };
    assets.push(entry);
    note(`net · ${JSON.stringify(entry)}`);
  });
  page.on("requestfailed", (request) => {
    const asset = assetOf(request.url());
    if (asset !== null)
      note(`net · /api/assets/<token>/${asset.name} · ${request.failure()?.errorText}`);
  });
  const headerDir = mkdtempSync(join(tmpdir(), "t3-client-curl-"));
  /** curl on a minted URL, its config on stdin so the token is in no argv: status, headers, body digest. */
  const curl = (url, headers = [], { pathAsIs = false } = {}) => {
    const headerFile = join(headerDir, "headers");
    const bodyFile = join(headerDir, "body");
    const config = [`url = "${url}"`, ...headers.map((header) => `header = "${header}"`)];
    spawnSync(
      "curl",
      ["-sS", "-o", bodyFile, "-D", headerFile, ...(pathAsIs ? ["--path-as-is"] : []), "-K", "-"],
      { input: `${config.join("\n")}\n` },
    );
    const lines = readFileSync(headerFile, "latin1").split(/\r?\n/);
    const body = readFileSync(bodyFile);
    rmSync(headerFile, { force: true });
    rmSync(bodyFile, { force: true });
    const header = (name) =>
      lines
        .find((line) => line.toLowerCase().startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim() ?? null;
    return {
      status: Number(/^HTTP\/[\d.]+ (\d+)/.exec(lines[0] ?? "")?.[1] ?? 0),
      contentType: header("content-type"),
      contentRange: header("content-range"),
      contentLength: header("content-length"),
      cacheControl: header("cache-control"),
      sha256: body.length === 0 ? null : sha256(body),
    };
  };

  const toasts = async (target = page) =>
    (await target.getByRole("region", { name: "Notifications" }).allInnerTexts())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  const shot = async (name) => {
    await capture(name);
    const shown = await toasts();
    if (shown) note(`observed · ${name} · toasts: ${shown}`);
  };

  const descriptor = await (await fetch(`${gateway}/.well-known/t3/environment`)).json();
  ok(
    descriptor.serverVersion === "v0.1.2+mend.1",
    `descriptor serverVersion ${descriptor.serverVersion}`,
  );
  const pairing = await api("/api/me/devices/pairings", { method: "POST" });
  ok(pairing.status === 200, `pairing code minted on the stack (via api) · HTTP ${pairing.status}`);
  registerSecret("t3-pairing-code", pairing.body.code);
  await page.goto(web);
  await page.getByRole("main").getByText("No computer connected").waitFor();
  await shot("01-no-environment");
  await page.getByRole("link", { name: "Add pairing link" }).click();
  await page.getByRole("button", { name: "Add environment" }).click();
  const addDialog = page.getByRole("dialog", { name: "Add Environment" });
  await typeSecret(
    addDialog.getByRole("textbox", { name: "Host" }),
    "t3-pairing-url",
    `${gateway}/pair#token=${pairing.body.code}`,
  );
  await addDialog.getByRole("button", { name: "Add environment" }).click();
  const row = page.getByRole("main").getByText(`${gateway}/ · Connected`);
  await row.waitFor();
  ok(true, `Settings → Connections lists Mend · ${gateway}/ · Connected`);
  await shot("02-paired");
  ok(
    (await page.getByRole("main").getByText("Mend", { exact: true }).count()) > 0,
    "the environment carries Mend's label",
  );
  ok(
    !(await page.getByRole("main").innerText()).includes("Update available"),
    "no version-mismatch line: the client takes v0.1.2+mend.1 as current",
  );
  await until("the client's server config", () => rpc.config, 15_000);
  ok(
    rpc.config.environment.serverVersion === "v0.1.2+mend.1",
    `subscribeServerConfig gave the client serverVersion ${rpc.config.environment.serverVersion}`,
  );
  const devices = await api("/api/me/devices");
  const labels = (Array.isArray(devices.body) ? devices.body : (devices.body?.devices ?? []))
    .map((device) => device.label ?? device.name)
    .filter((label) => /^t3code/.test(label ?? ""));
  note(`observed · Mend's devices (via api, HTTP ${devices.status}): ${JSON.stringify(labels)}`);

  if (process.env.MEND_VERIFY_T3_RETENTION) {
    await retentionProjects({ page, web, capture, note, api, ok, until, descriptor });
    return;
  }

  if (process.env.MEND_VERIFY_T3_REMOVAL) {
    await removalChecks({ page, web, capture, note, api, ok, until, rpc });
    return;
  }

  if (process.env.MEND_VERIFY_T3_SCRATCH) {
    await scratchProjects({ page, web, capture, note, api, ok, until, registerSecret, mend });
    return;
  }

  await page.goto(web);
  const main = page.getByRole("main");
  await main.getByRole("heading", { name: /What should we build in/ }).waitFor();
  ok(
    (await main.getByRole("heading", { name: /What should we build in/ }).innerText()).includes(
      "verify-fixture",
    ),
    "the new-thread page offers the stack's project verify-fixture",
  );
  await main.getByRole("button", { name: "Mend", exact: true }).click();
  ok(
    (await page
      .getByRole("menuitemradio", { name: "New worktree" })
      .getAttribute("aria-checked")) === "true",
    "Mend's workspace menu reads New worktree, checked",
  );
  await page.keyboard.press("Escape");
  const opening = `Opening message from the t3code client ${stamp}`;
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.click();
  await page.keyboard.type(opening);
  await page.getByRole("button", { name: "Submit message" }).click();
  const item = page.locator("li[data-thread-item]").filter({ hasText: opening });
  await item.waitFor();
  await main.getByRole("heading", { name: opening, level: 2 }).waitFor();
  const threadUrl = page.url();
  const threadId = threadUrl.split("/").at(-1);
  await shot("03-launched");
  const session = await until("Mend's session for the thread", async () => {
    const { body } = await api("/api/sessions");
    return (body ?? []).find((candidate) => candidate.label === opening);
  });
  ok(
    session.harness === "claude",
    `Mend has session ${session.id.slice(0, 8)} (via api) · ${session.harness} · ${session.status} · branch ${session.branch}`,
  );

  const turns = async () => {
    const { body } = await api(`/api/sessions/${session.id}/turns`);
    return (body?.turns ?? body ?? []).map((turn) => ({
      status: turn.status,
      text: turn.prompt ?? turn.request ?? turn.input ?? "",
    }));
  };
  await main.getByText("Failed to authenticate").first().waitFor({ timeout: 90_000 });
  ok(true, "the opening message ran as a turn: Claude's own refusal of the fake login shows");
  ok(
    (await turns()).some((turn) => turn.text === opening),
    `Mend recorded the opening message as a turn (via api): ${JSON.stringify(await turns())}`,
  );
  const submitting = main.getByRole("button", { name: "Submitting message" });
  const send = async (text) => {
    await composer.click();
    await page.keyboard.type(text);
    await submitting.waitFor({ state: "hidden" });
    await page.keyboard.press("Enter");
    await until(
      "the composer takes the message",
      async () => (await composer.innerText()).trim() === "",
      10_000,
    );
  };
  const second = `Second message ${stamp}`;
  const third = `Third message, queued ${stamp}`;
  const fourth = `Fourth message, queued ${stamp}`;
  await send(second);
  await send(third);
  await send(fourth);
  const stop = page.getByRole("button", { name: "Stop generation" });
  ok(await stop.isVisible(), "Stop generation shows while the second message's turn runs");
  await stop.click();
  await page.waitForTimeout(2000);
  await shot("04-interrupted");
  const queue = main.getByRole("region", { name: /queued messages?$/ });
  ok(
    await queue.isVisible(),
    `the queue holds after the interrupt: ${await queue.getAttribute("aria-label")}`,
  );
  await until("Mend's turn for the second message reads interrupted", async () =>
    (await turns()).find((turn) => turn.text === second && turn.status === "interrupted"),
  );
  ok(true, "Mend recorded the second message's turn as interrupted (via api)");
  await page.waitForTimeout(8000);
  const composerAction = main.getByRole("button", {
    name: /^(Submit message|Submitting message|Resume thread|Stop generation)$/,
  });
  const awaiting = [...rpc.open.values()].filter((tag) => !/^subscribe|\.subscribe/.test(tag));
  note(
    `observed · 10 s after the interrupt, live page · calls still unanswered: ${JSON.stringify(awaiting)} · working line: ${JSON.stringify(await main.getByText(/^Working for/).allInnerTexts())} · composer action: ${JSON.stringify(await composerAction.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))))}`,
  );
  await shot("05-interrupted-10s");

  await page.reload();
  await queue.waitFor();
  const rows = queue.getByRole("listitem");
  const held = await rows.allInnerTexts();
  ok(
    held.length >= 1 &&
      (await rows.getByRole("button", { name: "Send now" }).count()) === held.length,
    `after a reload the held queue lists ${held.length} queued message(s), each with Send now`,
  );
  await main.getByRole("button", { name: "Resume thread" }).waitFor();
  ok(true, "once the environment reconnects, the composer offers Resume thread");
  await shot("06-held-queue");

  const failuresBefore = rpc.failures.length;
  let tab2;
  if (held.length >= 2) {
    tab2 = await page.context().newPage();
    watchSocket(tab2, "tab2");
    await tab2.goto(threadUrl);
    const queue2 = tab2.getByRole("main").getByRole("region", { name: /queued messages?$/ });
    await queue2.waitFor();
    await tab2.getByRole("main").getByRole("button", { name: "Resume thread" }).waitFor();
    // Both buttons resolved first, then clicked in the same instant: Playwright's own click waits
    // for each button to settle, long enough for tab 2 to see tab 1's turn start and disable it.
    const buttons = await Promise.all([
      rows.first().getByRole("button", { name: "Send now" }).elementHandle(),
      queue2.getByRole("listitem").nth(1).getByRole("button", { name: "Send now" }).elementHandle(),
    ]);
    await Promise.all(buttons.map((button) => button.evaluate((element) => element.click())));
    note("Send now pressed at once: tab 1 on the first queued message, tab 2 on the second");
  } else {
    await rows.first().getByRole("button", { name: "Send now" }).click();
    note("Send now pressed on the one queued message (the race needs two: not run)");
  }
  await page.waitForTimeout(2500);
  await shot("07-send-now");
  const refusedRpc = rpc.failures
    .slice(failuresBefore)
    .filter((failure) => failure.message.includes(REFUSAL));
  const shownToasts = `${await toasts()} ${tab2 ? await toasts(tab2) : ""}`.trim();
  note(
    `observed · after Send now · rpc refusals with t3code's wording: ${JSON.stringify(refusedRpc)} · a toast shows it: ${shownToasts.includes(REFUSAL)} · toasts: ${shownToasts}`,
  );
  await tab2?.close();
  await until("Mend's turn for the message sent now", async () =>
    (await turns()).find(
      (turn) => turn.text !== opening && turn.text !== second && held[0].includes(turn.text),
    ),
  );
  ok(true, `Send now made a turn in Mend (via api): ${JSON.stringify(await turns())}`);
  await page.waitForTimeout(5000);
  note(`observed · Mend's turns 5 s later (via api): ${JSON.stringify(await turns())}`);
  await shot("08-after-send-now");

  const state = () => rpc.threads.get(threadId) ?? {};
  await item.hover();
  await item.getByRole("button", { name: "Snooze thread" }).click();
  await page.getByRole("menuitem", { name: /^In 1 hour/ }).click();
  await until("the shell's thread carries snoozedUntil", () => state().snoozedUntil, 15_000);
  ok(true, `snoozed · the shell's thread: ${JSON.stringify(state())}`);
  await page.waitForTimeout(1000);
  note(
    `observed · after snooze · the snoozed thread in the sidebar: ${await item.count()} · the page moved on to: ${page.url() === threadUrl ? "the same thread" : "another thread"}`,
  );
  await shot("09-snoozed");
  await page.goto(threadUrl);
  await main.getByRole("heading", { name: opening, level: 2 }).waitFor();
  await main.getByRole("button", { name: /^Thread actions for/ }).click();
  await page
    .getByRole("button", { name: "Settle thread" })
    .filter({ hasText: "Settle thread" })
    .click();
  await until("the shell's thread carries settledAt", () => state().settledAt, 15_000);
  ok(
    state().snoozedUntil == null,
    `settled, and the settle ended the snooze · the shell's thread: ${JSON.stringify(state())}`,
  );
  await main.getByRole("button", { name: /^Thread actions for/ }).click();
  await shot("10-settled-actions");
  await page.keyboard.press("Escape");

  await main.getByRole("button", { name: "Toggle terminal drawer" }).click();
  const terminalInput = page.locator("textarea.t3-ghostty-input");
  await terminalInput.waitFor();
  const terminalStates = (from = 0) =>
    rpc.terminals.slice(from).filter((entry) => entry.threadId === threadId);
  await until(
    "the terminal runs",
    () => terminalStates().some((entry) => entry.status === "running"),
    30_000,
  );
  ok(true, "the terminal opened: the gateway reported it running");
  await terminalInput.focus();
  await page.keyboard.type("printf 'written from the t3code terminal\\n' > verify-terminal.txt");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await until(
    "the terminal reports exited",
    () => terminalStates().some((entry) => entry.status === "exited"),
    20_000,
  );
  ok(true, "the shell exited: the gateway reported the terminal exited");
  note(
    `observed · the terminal's output, from its frames: ${JSON.stringify(stripAnsi(rpc.transcript))}`,
  );
  await page.waitForTimeout(1500);
  note(
    `observed · after exit · terminal inputs on the page: ${await terminalInput.count()} · the client's terminal calls: ${JSON.stringify([...new Set(rpc.terminals.filter((entry) => entry.threadId === threadId && entry.resume !== undefined).map((entry) => entry.call))])}`,
  );
  await shot("11-terminal-exited");
  const beforeReload = rpc.terminals.length;
  await page.reload();
  await main.getByRole("heading", { name: opening, level: 2 }).waitFor();
  await page.waitForTimeout(6000);
  const afterReload = terminalStates(beforeReload);
  note(
    `observed · the thread's terminal calls and states after the reload: ${JSON.stringify(afterReload)}`,
  );
  ok(
    !afterReload.some((entry) => entry.status === "running"),
    "after the reload no terminal of the thread runs: the stopped one was not started again",
  );
  note(`observed · after the reload · terminal inputs on the page: ${await terminalInput.count()}`);
  await shot("12-terminal-after-reload");

  const rightPanel = main.getByRole("button", { name: "Toggle right panel" });
  if ((await rightPanel.getAttribute("aria-pressed")) !== "true") await rightPanel.click();
  const files = main.getByRole("button", { name: /^Files/ });
  if (await files.isVisible()) await files.click();
  else {
    await main.getByRole("button", { name: "Add panel surface" }).click();
    await page.getByRole("menuitem", { name: /^Files/ }).click();
  }
  const tree = main.getByRole("tree");
  await tree.getByRole("treeitem", { name: "README.md" }).waitFor();
  // The default captured store lists the worktree as its newest registered capture holds it, so a
  // file the terminal wrote shows once a capture after it is registered.
  const listed = async (name, ms = 300_000) => {
    const since = Date.now();
    await until(
      `the Files panel lists ${name}`,
      async () => {
        await main.getByRole("button", { name: "Refresh workspace files" }).click();
        await page.waitForTimeout(1500);
        return (await tree.getByRole("treeitem", { name, exact: true }).count()) > 0;
      },
      ms,
    );
    note(
      `observed · ${name} listed ${Math.round((Date.now() - since) / 1000)} s after the wait began`,
    );
  };
  await listed("verify-terminal.txt");
  ok(true, "the Files panel lists the worktree's README.md and the terminal's verify-terminal.txt");
  await tree.getByRole("treeitem", { name: "README.md" }).click();
  await main.getByRole("code").filter({ hasText: "# Verify fixture" }).waitFor();
  ok(true, "README.md opens with the fixture's text");
  await shot("13-files");
  await main.getByRole("button", { name: "Add panel surface" }).click();
  await page.getByRole("menuitem", { name: /^Diff/ }).click();
  await main.getByRole("button", { name: "Expand verify-terminal.txt" }).waitFor();
  ok(
    await main.getByRole("group", { name: "1 additions, 0 deletions" }).isVisible(),
    "the Diff panel compares the worktree with main: verify-terminal.txt, 1 addition",
  );
  await main.getByRole("button", { name: "Expand verify-terminal.txt" }).click();
  await page.waitForTimeout(1000);
  await shot("14-diff");

  const fixtures = previewFixtures();
  const written = new Map([...fixtures].map(([path, bytes]) => [path, sha256(bytes)]));
  const toggleTerminal = main.getByRole("button", { name: "Toggle terminal drawer" });
  const prompts = () => rpc.transcript.split("\u001b[?2004h").length;
  /** Pastes `script` into Mend's shell in the worktree, runs it, and waits for its last line. */
  const pasteAndRun = async (file, script, marker, ms = 120_000) => {
    await toggleTerminal.click();
    await page.waitForTimeout(1500);
    if ((await terminalInput.count()) === 0) await toggleTerminal.click();
    // The drawer opened again keeps the shell it ran before beside a new one.
    const input = terminalInput.filter({ visible: true }).last();
    await input.waitFor();
    await page.waitForTimeout(2000);
    await input.focus();
    await page.keyboard.type(`stty -echo; cat > ${file}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    for (let at = 0; at < script.length; at += 16_384)
      await input.evaluate(
        (input, text) => {
          const data = new DataTransfer();
          data.setData("text/plain", text);
          input.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        },
        script.slice(at, at + 16_384),
      );
    const shown = prompts();
    await page.keyboard.press("Control+d");
    await until("the shell's prompt after the pasted script", () => prompts() > shown, 120_000);
    const from = rpc.transcript.length;
    await page.keyboard.type(`stty echo; sh ${file}`);
    await page.keyboard.press("Enter");
    await until(`${file}'s end`, () => rpc.transcript.slice(from).includes(marker), ms);
    await toggleTerminal.click();
    return stripAnsi(rpc.transcript.slice(from));
  };
  const digestsShown = await pasteAndRun(
    "/tmp/preview-fixtures.sh",
    fixtureScript(fixtures),
    "preview-fixtures-written",
  );
  for (const [path, digest] of written)
    ok(
      digestsShown.includes(`${digest}  ${path}`),
      `${path} pasted through the terminal byte for byte (sha256 ${digest.slice(0, 12)})`,
    );

  const showFiles = async () => {
    if ((await rightPanel.getAttribute("aria-pressed")) !== "true") await rightPanel.click();
    if (await files.isVisible()) await files.click();
    else {
      await main.getByRole("button", { name: "Add panel surface" }).click();
      await page.getByRole("menuitem", { name: /^Files/ }).click();
    }
    await tree.getByRole("treeitem", { name: "README.md" }).waitFor();
  };
  /** The tree's rows down to `trail`'s last folder, each folder opened that does not show its child. */
  const reveal = async (...trail) => {
    for (const [index, name] of trail.entries()) {
      const child = trail[index + 1];
      if (child === undefined) break;
      if ((await tree.getByRole("treeitem", { name: child, exact: true }).count()) === 0)
        await tree.getByRole("treeitem", { name, exact: true }).click();
    }
  };
  await showFiles();
  await listed("preview");
  await reveal("preview", "version.txt");
  await listed("version.txt");
  const open = async (name) => {
    const from = assets.length;
    await tree.getByRole("treeitem", { name, exact: true }).click();
    return () => assets.slice(from).filter((entry) => entry.path.endsWith(`/${name}`));
  };
  const unavailable = main.getByText(
    /^(Unable to load workspace image\.|Unable to load file preview\.|Video unavailable)/,
  );
  // A captured file's first mint unpacks it on Mend, bounded at about ten seconds; past that the
  // client shows it unavailable, and opening it again once it is ready previews it. A person
  // reopens a video with its Retry video, and anything else by reloading the page.
  const reopenByReload =
    (...trail) =>
    async () => {
      await page.reload();
      await main.getByRole("heading", { name: opening, level: 2 }).waitFor();
      await showFiles();
      await reveal(...trail);
      return open(trail.at(-1));
    };
  const reopenByRetry = (name) => async () => {
    const from = assets.length;
    await main.getByRole("button", { name: "Retry video" }).click();
    return () => assets.slice(from).filter((entry) => entry.path.endsWith(`/${name}`));
  };
  const mintsOf = (name, from) =>
    rpc.mints
      .slice(from)
      .filter((mint) => mint.name === name)
      .map(({ ms, ok, message }) => ({ ms, ok, ...(message ? { message } : {}) }));
  /** Opens a file until it previews, reopening while the client reads it unavailable. */
  const previewed = async (trail, rendered, reopen, attempts = 4) => {
    const name = trail.at(-1);
    let served;
    for (let attempt = 1; ; attempt += 1) {
      const mintsFrom = rpc.mints.length;
      served = attempt === 1 ? await open(name) : await reopen();
      const outcome = await until(
        `${name} previews or reads unavailable`,
        async () =>
          (await rendered()) ? "previews" : (await unavailable.count()) > 0 ? "unavailable" : null,
        90_000,
      );
      note(
        `observed · ${name} · open ${attempt} · ${outcome} · its mints: ${JSON.stringify(mintsOf(name, mintsFrom))}`,
      );
      if (outcome === "previews") return { served, attempt };
      if (attempt === attempts)
        throw new Error(`does not hold · ${name} still unavailable after ${attempt} opens`);
      await page.waitForTimeout(10_000);
    }
  };
  // The driver withholds a screenshot with an SVG path over 1500 characters (a QR code). Here
  // those are the client's hidden file-icon sprite and Claude's logo, so a preview's capture
  // removes exactly those two first, and says so.
  const previewShot = async (name) => {
    const removed = await page.evaluate(() => {
      const found = [
        ...document.querySelectorAll(
          '#t3code-pierre-file-icon-sprite svg, svg[viewBox="0 0 256 257"]',
        ),
      ];
      for (const svg of found) svg.remove();
      return found.length;
    });
    note(
      `observed · ${name} · removed ${removed} file-icon sprite and Claude logo SVG(s) before the capture`,
    );
    await shot(name);
  };
  const decoded = (image, width) => async () =>
    (await image.count()) > 0 &&
    (await image.evaluate((element, w) => element.complete && element.naturalWidth === w, width));
  const decodes = (image, width) =>
    until(`the image decodes at ${width} px`, () =>
      image.evaluate((element, w) => element.complete && element.naturalWidth === w, width),
    );

  const png = main.locator('img[alt="preview/pixel.png"]');
  let { served } = await previewed(
    ["preview", "pixel.png"],
    decoded(png, 64),
    reopenByReload("preview", "pixel.png"),
  );
  ok(
    served().some(
      (entry) =>
        entry.status === 200 &&
        entry.contentType === "image/png" &&
        entry.cacheControl === "private, no-store",
    ),
    `pixel.png previews, decoded at 64 × 64: ${JSON.stringify(served())}`,
  );
  await previewShot("15-preview-png");

  ({ served } = await previewed(
    ["preview", "logo.svg"],
    decoded(main.locator('img[alt="preview/logo.svg"]'), 96),
    reopenByReload("preview", "logo.svg"),
  ));
  ok(
    served().some(
      (entry) =>
        entry.status === 200 && entry.contentType === "image/svg+xml" && entry.csp === SVG_POLICY,
    ),
    `logo.svg previews, served with the sandbox CSP: ${JSON.stringify(served())}`,
  );
  await previewShot("16-preview-svg");

  ({ served } = await previewed(
    ["preview", "crlf.svg"],
    decoded(main.locator('img[alt="preview/crlf.svg"]'), 96),
    reopenByReload("preview", "crlf.svg"),
  ));
  ok(
    served().some((entry) => entry.status === 200 && entry.contentType === "image/svg+xml"),
    `crlf.svg (CRLF line ends, \`text eol=lf\` in preview/.gitattributes) previews: ${JSON.stringify(served())}`,
  );
  const crlfFiltered = /filtered ([0-9a-f]{40})/.exec(digestsShown)?.[1];
  const crlfRaw = /unfiltered ([0-9a-f]{40})/.exec(digestsShown)?.[1];
  ok(
    crlfFiltered !== undefined && crlfRaw !== undefined && crlfFiltered !== crlfRaw,
    `git in the worktree stores crlf.svg normalized: hash-object ${crlfFiltered?.slice(0, 12)} with the eol filter, ${crlfRaw?.slice(0, 12)} without`,
  );

  const embed = main.locator("embed");
  ({ served } = await previewed(
    ["preview", "doc.pdf"],
    async () => (await embed.count()) > 0,
    reopenByReload("preview", "doc.pdf"),
  ));
  await page.waitForTimeout(3000);
  ok(
    (await embed.getAttribute("type")) === "application/pdf" && minted.has("doc.pdf"),
    "doc.pdf previews as an application/pdf embed of a URL the gateway minted",
  );
  note(
    `observed · doc.pdf · this Chromium's pdfViewerEnabled ${await page.evaluate(() => navigator.pdfViewerEnabled)} · the embed's fetches: ${JSON.stringify(served())}`,
  );
  await shot("17-preview-pdf");

  const video = main.locator("video");
  const playable = (seconds) => async () =>
    (await video.count()) > 0 &&
    (await video.evaluate(
      (element, s) => element.readyState >= 1 && element.duration > s,
      seconds,
    ));
  ({ served } = await previewed(["preview", "clip.mp4"], playable(9), reopenByRetry("clip.mp4")));
  const beforeSeek = served().length;
  await video.evaluate((element) => {
    element.muted = true;
    return element.play().catch(() => undefined);
  });
  await page.waitForTimeout(1000);
  await video.evaluate(
    (element) =>
      new Promise((resolve) => {
        element.addEventListener("seeked", resolve, { once: true });
        element.currentTime = 9.2;
      }),
  );
  await page.waitForTimeout(2000);
  const playback = await video.evaluate((element) => ({
    currentTime: element.currentTime,
    readyState: element.readyState,
    error: element.error?.code ?? null,
    videoWidth: element.videoWidth,
  }));
  ok(
    served().length > 0 &&
      served().every(
        (entry) =>
          entry.range !== null &&
          entry.status === 206 &&
          entry.contentType === "video/mp4" &&
          /^bytes \d+-\d+\/\d+$/.test(entry.contentRange ?? ""),
      ) &&
      playback.error === null &&
      playback.videoWidth === 640,
    `clip.mp4 plays (${JSON.stringify(playback)}); every request carried a Range and was answered 206: ${JSON.stringify(served())}`,
  );
  note(`observed · clip.mp4 · the seek's requests: ${JSON.stringify(served().slice(beforeSeek))}`);
  await shot("18-preview-video");

  await reveal("preview", "site", "index.html");
  const frameElement = main.locator("iframe");
  const { served: htmlServed } = await previewed(
    ["preview", "site", "index.html"],
    async () => (await frameElement.count()) > 0,
    reopenByReload("preview", "site", "index.html"),
  );
  const frame = await (await frameElement.elementHandle()).contentFrame();
  await frame.locator("#styled").waitFor();
  const color = await frame
    .locator("#styled")
    .evaluate((element) => getComputedStyle(element).color);
  const stylesheet = assets.filter((entry) => entry.path.endsWith("/style.css"));
  ok(
    htmlServed().some(
      (entry) =>
        entry.status === 200 &&
        entry.contentType === "text/html; charset=utf-8" &&
        entry.csp === HTML_POLICY,
    ) &&
      stylesheet.some((entry) => entry.status === 200 && entry.contentType === "text/css") &&
      color === "rgb(1, 2, 3)",
    `index.html previews in a sandboxed frame with its relative style.css applied (color ${color}): ${JSON.stringify([...htmlServed(), ...stylesheet])}`,
  );
  await shot("19-preview-html");

  served = await open("data.bin");
  await main.getByText("The file is binary and cannot be displayed as text.").waitFor();
  await page.waitForTimeout(1500);
  ok(
    served().length === 0,
    "data.bin shows `The file is binary and cannot be displayed as text.`, and no asset URL is fetched",
  );
  await previewShot("20-preview-binary");

  const byName = new Map([...written].map(([path, digest]) => [path.split("/").at(-1), digest]));
  for (const [name, url] of [...minted].filter(([file]) => byName.has(file))) {
    const result = curl(url);
    ok(
      result.status === 200 &&
        result.cacheControl === "private, no-store" &&
        result.sha256 === byName.get(name),
      `curl · ${name} · the minted URL answers the file byte for byte · ${JSON.stringify(result)}`,
    );
  }
  const crlfBytes = fixtures.get("preview/crlf.svg");
  const crlfServed = curl(minted.get("crlf.svg"));
  ok(
    crlfServed.sha256 === sha256(crlfBytes) &&
      crlfServed.sha256 !== sha256(Buffer.from(crlfBytes.toString().replace(/\r\n/g, "\n"))) &&
      crlfServed.contentLength === String(crlfBytes.length),
    `curl · crlf.svg · the worktree's CRLF bytes (${crlfBytes.length} B, sha256 ${sha256(crlfBytes).slice(0, 12)}), not the LF-normalized blob · ${JSON.stringify(crlfServed)}`,
  );
  const pngUrl = minted.get("pixel.png");
  const pngRange = curl(pngUrl, ["Range: bytes=0-9"]);
  ok(
    pngRange.status === 200 &&
      pngRange.contentLength === String(fixtures.get("preview/pixel.png").length),
    `curl · pixel.png with Range: bytes=0-9 · whole, 200: ranges are for audio and video · ${JSON.stringify(pngRange)}`,
  );
  const elsewhere = curl(`${pngUrl.slice(0, pngUrl.lastIndexOf("/"))}/logo.svg`);
  ok(
    elsewhere.status === 404,
    `curl · pixel.png's token with logo.svg · ${elsewhere.status}: the token is the file's`,
  );
  const mp4 = minted.get("clip.mp4");
  const partial = curl(mp4, ["Range: bytes=0-99"]);
  const size = fixtures.get("preview/clip.mp4").length;
  ok(
    partial.status === 206 && partial.contentRange === `bytes 0-99/${size}`,
    `curl · clip.mp4 with Range: bytes=0-99 · ${JSON.stringify(partial)}`,
  );
  const beyond = curl(mp4, [`Range: bytes=${size}-`]);
  ok(
    beyond.status === 416 && beyond.contentRange === `bytes */${size}`,
    `curl · clip.mp4 with Range: bytes=${size}- · ${JSON.stringify(beyond)}`,
  );
  const html = minted.get("index.html");
  const directory = html.slice(0, html.lastIndexOf("/"));
  for (const [what, suffix, pathAsIs, status] of [
    ["the page's directory", "/style.css", false, 200],
    ["`..` as is", "/../secret.css", true, 404],
    ["`%2e%2e`", "/%2e%2e/secret.css", true, 404],
    ["`..%2f`", "/..%2fsecret.css", true, 404],
    ["a symlink to ../secret.css", "/escape.css", false, 404],
  ]) {
    const result = curl(`${directory}${suffix}`, [], { pathAsIs });
    ok(
      result.status === status,
      `curl · index.html's token, ${what} (<token>${suffix}) · ${JSON.stringify(result)}`,
    );
  }

  // Mend's side of a captured read, as the gateway asks it (via api, read only): the raw route's
  // status, the capture it read and its observation, and the body's digest for a GET.
  const worktreeId = session.worktreeId;
  const raw = async (path, { method = "HEAD", at } = {}) => {
    const query = new URLSearchParams({ path, ...(at === undefined ? {} : { at }) });
    const res = await fetch(`${mend}/api/worktrees/${worktreeId}/raw?${query}`, {
      method,
      headers: { authorization: `Bearer ${token}`, origin: mend },
    });
    const body = method === "GET" ? Buffer.from(await res.arrayBuffer()) : null;
    return {
      status: res.status,
      contentLength: res.headers.get("content-length"),
      captureId: res.headers.get("x-mend-capture-id")?.slice(0, 12) ?? null,
      observation: res.headers.get("x-mend-observation"),
      ...(body !== null && res.status === 200
        ? { sha256: sha256(body).slice(0, 12), text: body.length <= 64 ? body.toString() : null }
        : {}),
    };
  };
  const pixelRead = await raw("preview/pixel.png");
  ok(
    pixelRead.status === 200 && pixelRead.captureId !== null,
    `raw HEAD · preview/pixel.png · Mend read it from a capture · ${JSON.stringify(pixelRead)}`,
  );
  const versionOne = await raw("preview/version.txt", { method: "GET" });
  ok(
    versionOne.status === 200 && versionOne.text === VERSION_ONE,
    `raw GET · preview/version.txt · the captured version one · ${JSON.stringify(versionOne)}`,
  );
  const marked = await api(`/api/worktrees/${worktreeId}/checkpoints`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trigger: "user-mark" }),
  });
  ok(
    marked.status === 200 && typeof marked.body?.id === "string",
    `a checkpoint marked (via api, setup) · HTTP ${marked.status} · ordinal ${marked.body?.ordinal}`,
  );
  const checkpoint = marked.body.id;
  const atCheckpoint = await until(
    "the marked checkpoint's raw read",
    async () => {
      const read = await raw("preview/version.txt", { method: "GET", at: checkpoint });
      return read.status === 200 ? read : null;
    },
    120_000,
  );
  ok(
    atCheckpoint.text === VERSION_ONE,
    `raw GET at the checkpoint · preview/version.txt · ${JSON.stringify(atCheckpoint)}`,
  );
  const largeShown = await pasteAndRun(
    "/tmp/large-fixtures.sh",
    largeScript(),
    "large-fixtures-written",
    300_000,
  );
  note(`observed · the large fixtures in the worktree: ${JSON.stringify(largeShown.trim())}`);
  await listed("big.mp4", 900_000);
  await listed("ignored.png", 5_000).then(
    () => ok(false, "ignored.png, gitignored, is listed"),
    () => ok(true, "ignored.png, gitignored, is not listed in the Files panel"),
  );
  const ignored = await raw("preview/ignored.png");
  ok(ignored.status === 404, `raw HEAD · preview/ignored.png · ${JSON.stringify(ignored)}`);
  const versionTwo = await raw("preview/version.txt", { method: "GET" });
  ok(
    versionTwo.status === 200 && versionTwo.text === VERSION_TWO,
    `raw GET · preview/version.txt · now version two, from a newer capture · ${JSON.stringify(versionTwo)}`,
  );
  const stillOne = await raw("preview/version.txt", { method: "GET", at: checkpoint });
  ok(
    stillOne.status === 200 && stillOne.text === VERSION_ONE,
    `raw GET at the checkpoint · preview/version.txt · still the checkpoint's version one · ${JSON.stringify(stillOne)}`,
  );
  const before = (await api(`/api/worktrees/${worktreeId}`)).body?.checkpoints ?? [];
  const earliest = before.find((item) => item.ordinal === 0);
  if (earliest !== undefined) {
    const absent = await raw("preview/version.txt", { at: earliest.id });
    ok(
      absent.status === 404,
      `raw HEAD at checkpoint 0, before the fixtures · preview/version.txt · ${JSON.stringify(absent)}`,
    );
  }

  note("observed · big.mp4 · the first open begins");
  const big = await previewed(["preview", "big.mp4"], playable(9), reopenByRetry("big.mp4"), 12);
  ok(
    big.served().some((entry) => entry.status === 206 && entry.contentType === "video/mp4"),
    `big.mp4 (the clip and 300 MiB) previews after ${big.attempt} open(s): ${JSON.stringify(big.served())}`,
  );
  await page.waitForTimeout(3000);
  const seekFrom = assets.length;
  note("window · big.mp4 · seeks · begins");
  for (const at of [5, 9.2, 2])
    await video.evaluate(
      (element, seconds) =>
        new Promise((resolve) => {
          element.addEventListener("seeked", resolve, { once: true });
          element.currentTime = seconds;
        }),
      at,
    );
  await page.waitForTimeout(2000);
  note("window · big.mp4 · seeks · ends");
  const seeks = assets.slice(seekFrom).filter((entry) => entry.path.endsWith("/big.mp4"));
  ok(
    seeks.length > 0 && seeks.every((entry) => entry.status === 206 && entry.range !== null),
    `big.mp4 · the seeks' requests each answered 206: ${JSON.stringify(seeks)}`,
  );
  await shot("19b-preview-big-video");
  const mintsFrom = rpc.mints.length;
  note("window · big.mp4 · reopened after a reload · begins");
  await reopenByReload("preview", "big.mp4")();
  await until("big.mp4 previews again after a reload", playable(9), 60_000);
  await page.waitForTimeout(1500);
  note("window · big.mp4 · reopened after a reload · ends");
  ok(
    mintsOf("big.mp4", mintsFrom).some((mint) => mint.ok),
    `big.mp4 · opened again after a reload, a new mint · ${JSON.stringify(mintsOf("big.mp4", mintsFrom))}`,
  );

  const hugeShown = await pasteAndRun(
    "/tmp/huge-fixture.sh",
    hugeScript(),
    "huge-fixture-written",
    300_000,
  );
  note(`observed · the huge fixture in the worktree: ${JSON.stringify(hugeShown.trim())}`);
  await showFiles();
  await reveal("preview", "big.mp4");
  await listed("huge.mp4", 900_000);
  const hugeFrom = rpc.mints.length;
  await open("huge.mp4");
  await unavailable.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(12_000);
  await main.getByRole("button", { name: "Retry video" }).click();
  await page.waitForTimeout(5000);
  ok(
    (await unavailable.count()) > 0 &&
      mintsOf("huge.mp4", hugeFrom).length > 0 &&
      mintsOf("huge.mp4", hugeFrom).every((mint) => mint.ok === false),
    `huge.mp4 (the clip and 2 GiB) reads Video unavailable, and again after Retry video: ${JSON.stringify(mintsOf("huge.mp4", hugeFrom))}`,
  );
  await shot("19c-preview-huge-unavailable");
  const huge = await raw("preview/huge.mp4");
  ok(huge.status === 413, `raw HEAD · preview/huge.mp4 · ${JSON.stringify(huge)}`);

  if ((await rightPanel.getAttribute("aria-pressed")) === "true") await rightPanel.click();
  const pasted = fixtures.get("preview/pixel.png").toString("base64");
  const beforeChat = assets.length;
  await composer.click();
  await composer.evaluate((editor, base64) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    editor.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, pasted);
  await page.waitForTimeout(1500);
  await page.keyboard.type(`A pasted image ${stamp}`);
  await submitting.waitFor({ state: "hidden" });
  await page.keyboard.press("Enter");
  const chatImage = main.locator('img[src*="/api/assets/"]').first();
  await decodes(chatImage, 64);
  const chatServed = () =>
    assets.slice(beforeChat).filter((entry) => entry.path.endsWith("/pasted.png"));
  ok(
    chatServed().some(
      (entry) =>
        entry.status === 200 &&
        entry.contentType === "image/png" &&
        entry.cacheControl === "private, no-store",
    ),
    `a pasted chat image shows in the sent message from a minted asset URL: ${JSON.stringify(chatServed())}`,
  );
  await previewShot("21-chat-image");
  const beforeChatReload = assets.length;
  await page.reload();
  await decodes(chatImage, 64);
  ok(
    assets
      .slice(beforeChatReload)
      .some((entry) => entry.path.endsWith("/pasted.png") && entry.status === 200),
    "after a reload the message's image loads again",
  );

  const calls = [...new Set(rpc.calls.values())].sort();
  note(`rpc · methods the client called: ${calls.join(", ")}`);
  const refused = new Map();
  for (const { tag, message } of rpc.failures) {
    if (/^\[(\{"_tag":"Interrupt","fiberId":\d+\},?)+\]$/.test(message)) continue;
    const key = `${tag} · ${message}`;
    refused.set(key, (refused.get(key) ?? 0) + 1);
  }
  for (const [key, count] of refused) note(`rpc · refused ×${count} · ${key}`);

  await page.goto(new URL("/login", mend).href);
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  await page.getByRole("textbox", { name: "Email" }).fill(account.email);
  await typeSecret(
    page.getByLabel("Password", { exact: true }),
    "account-password",
    account.password,
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  if (new URL(page.url()).pathname === "/welcome")
    await page.getByRole("button", { name: "Continue to Mend" }).click();
  await page.goto(new URL("/settings#devices", mend).href);
  await page.getByRole("heading", { name: "Devices" }).waitFor();
  const paired = page
    .locator("#devices div.flex.items-start")
    .filter({ hasText: "t3code · T3 Code Web" });
  ok(
    (await paired.count()) > 0,
    `Mend's Settings → Devices lists ${await paired.count()} t3code · T3 Code Web device(s)`,
  );
  await shot("22-devices");
  for (const [name, url] of minted)
    ok(curl(url).status === 200, `curl · before the revoke · ${name} · 200`);
  while ((await paired.count()) > 0) {
    await paired.first().getByRole("button", { name: "Revoke" }).click();
    await paired.first().getByRole("button", { name: "Confirm revoke" }).click();
    await page.waitForTimeout(1000);
  }
  const revokedAt = Date.now();
  await shot("23-devices-revoked");
  note(
    `observed · right after the revoke: ${JSON.stringify([...minted].map(([name, url]) => [name, curl(url).status, `${Date.now() - revokedAt} ms`]))}`,
  );
  await page.waitForTimeout(Math.max(0, revokedAt + 6000 - Date.now()));
  for (const [name, url] of minted) {
    const result = curl(url);
    ok(
      result.status === 404 && result.cacheControl === "private, no-store",
      `curl · ${Date.now() - revokedAt} ms after the revoke · ${name} · ${JSON.stringify(result)}`,
    );
  }
  rmSync(headerDir, { recursive: true, force: true });
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pngChunk = (type, data) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([head, Buffer.from(type), data, tail]);
};

/**
 * The preview fixtures, by worktree path: a 64 × 64 PNG, an SVG, a one-page PDF, a 10-second VP9
 * MP4 (Playwright's Chromium decodes no H.264), an HTML page with a relative stylesheet, a
 * stylesheet outside the page's directory, and 4 KiB of binary.
 */
const previewFixtures = () => {
  const rows = Buffer.alloc(64 * (64 * 3 + 1));
  for (let y = 0; y < 64; y += 1)
    for (let x = 0; x < 64; x += 1) rows.set([x * 4, y * 4, 160], y * (64 * 3 + 1) + 1 + x * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const text = "BT /F1 18 Tf 24 64 Td (Mend raw preview) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const at = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) pdf += `${String(at).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const scratch = mkdtempSync(join(tmpdir(), "t3-client-mp4-"));
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=25",
      "-t",
      "10",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "500k",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-movflags",
      "+faststart",
      join(scratch, "clip.mp4"),
    ],
    { encoding: "utf8" },
  );
  if (encoded.status !== 0)
    throw new Error(`ffmpeg made no MP4: ${encoded.stderr ?? encoded.error}`);
  const mp4 = readFileSync(join(scratch, "clip.mp4"));
  rmSync(scratch, { recursive: true, force: true });
  return new Map([
    ["preview/pixel.png", png],
    [
      "preview/logo.svg",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="12" fill="#1d4ed8"/><circle cx="48" cy="48" r="24" fill="#f8fafc"/></svg>\n',
      ),
    ],
    ["preview/doc.pdf", Buffer.from(pdf)],
    ["preview/clip.mp4", mp4],
    [
      "preview/site/index.html",
      Buffer.from(
        '<!doctype html>\n<html><head><meta charset="utf-8"><title>Site preview</title><link rel="stylesheet" href="style.css"></head>\n<body><p id="styled">Styled by a relative style.css</p></body></html>\n',
      ),
    ],
    ["preview/site/style.css", Buffer.from("#styled { color: rgb(1, 2, 3); font-size: 28px; }\n")],
    [
      "preview/secret.css",
      Buffer.from("/* outside the page's directory */\nbody { color: red; }\n"),
    ],
    ["preview/data.bin", Buffer.concat([Buffer.from([0, 1, 2, 0, 255]), randomBytes(4091)])],
    ["preview/version.txt", Buffer.from(VERSION_ONE)],
    [
      "preview/crlf.svg",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">\r\n<rect width="96" height="96" fill="#15803d"/>\r\n</svg>\r\n',
      ),
    ],
    ["preview/.gitattributes", Buffer.from("crlf.svg text eol=lf\n")],
  ]);
};

/** A script that writes each fixture from base64, links site/escape.css out of its directory, and prints the digests. */
const fixtureScript = (fixtures) =>
  [
    "set -e",
    "mkdir -p preview/site",
    ...[...fixtures].flatMap(([path, bytes]) => [
      `base64 -d > ${path} <<'B64'`,
      ...(bytes.toString("base64").match(/.{1,76}/g) ?? []),
      "B64",
    ]),
    "ln -sfn ../secret.css preview/site/escape.css",
    `sha256sum ${[...fixtures.keys()].join(" ")}`,
    'echo "filtered $(git hash-object preview/crlf.svg)"',
    'echo "unfiltered $(git hash-object --no-filters preview/crlf.svg)"',
    "echo preview-fixtures-written",
    "",
  ].join("\n");

const FREE_BOX =
  'const free = (n) => { const h = Buffer.alloc(16); h.writeUInt32BE(1, 0); h.write("free", 4); h.writeBigUInt64BE(BigInt(n + 16), 8); return h; };';

/**
 * big.mp4 in the worktree: the clip's chunks spread through a 300 MiB `mdat`, random bytes between
 * them, each chunk offset moved to match. It plays as the clip does, and a seek lands far into the
 * file, past what the browser has read. Runs in the workspace's Node, from its source text.
 */
function writeBig(fs, crypto, bytes) {
  const clip = fs.readFileSync("preview/clip.mp4");
  const top = {};
  for (let at = 0; at < clip.length; at += clip.readUInt32BE(at))
    top[clip.toString("latin1", at + 4, at + 8)] = { at, size: clip.readUInt32BE(at) };
  const moov = Buffer.from(clip.subarray(top.moov.at, top.moov.at + top.moov.size));
  const table = {};
  const walk = (from, to) => {
    for (let at = from; at < to; at += moov.readUInt32BE(at)) {
      const type = moov.toString("latin1", at + 4, at + 8);
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(type))
        walk(at + 8, at + moov.readUInt32BE(at));
      if (["stsz", "stsc", "stco"].includes(type)) table[type] = at;
    }
  };
  walk(8, moov.length);
  const sizes = [];
  const uniform = moov.readUInt32BE(table.stsz + 12);
  for (let i = 0; i < moov.readUInt32BE(table.stsz + 16); i += 1)
    sizes.push(uniform || moov.readUInt32BE(table.stsz + 20 + 4 * i));
  const chunks = moov.readUInt32BE(table.stco + 12);
  const runs = [];
  for (let i = 0; i < moov.readUInt32BE(table.stsc + 12); i += 1)
    runs.push([
      moov.readUInt32BE(table.stsc + 16 + 12 * i),
      moov.readUInt32BE(table.stsc + 20 + 12 * i),
    ]);
  const pad = Math.floor(bytes / chunks);
  const out = fs.openSync("preview/big.mp4", "w");
  let position = top.ftyp.size + moov.length + 16;
  let sample = 0;
  const body = [];
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    const perChunk = runs.filter(([first]) => first <= chunk + 1).at(-1)[1];
    const length = sizes.slice(sample, sample + perChunk).reduce((sum, size) => sum + size, 0);
    sample += perChunk;
    const from = moov.readUInt32BE(table.stco + 16 + 4 * chunk);
    moov.writeUInt32BE(position, table.stco + 16 + 4 * chunk);
    body.push([from, length]);
    position += length + pad;
  }
  const mdat = Buffer.alloc(16);
  mdat.writeUInt32BE(1, 0);
  mdat.write("mdat", 4);
  mdat.writeBigUInt64BE(BigInt(position - top.ftyp.size - moov.length), 8);
  fs.writeSync(out, clip.subarray(0, top.ftyp.size));
  fs.writeSync(out, moov);
  fs.writeSync(out, mdat);
  for (const [from, length] of body) {
    fs.writeSync(out, clip.subarray(from, from + length));
    for (let left = pad; left > 0; left -= 2 ** 20)
      fs.writeSync(out, crypto.randomBytes(Math.min(left, 2 ** 20)));
  }
  fs.closeSync(out);
}

/**
 * A script for Mend's shell, after the checkpoint: version.txt changed, a gitignored copy of
 * pixel.png, and big.mp4 (the clip spread through 300 MiB of random bytes, still playable).
 */
const largeScript = () =>
  [
    "set -e",
    `printf '${VERSION_TWO.replace("\n", "\\n")}' > preview/version.txt`,
    "printf 'preview/ignored.png\\n' >> .gitignore",
    "cp preview/pixel.png preview/ignored.png",
    "cat > /tmp/write-big.js <<'JS'",
    `(${writeBig})(require("fs"), require("crypto"), 300 * 2 ** 20);`,
    "JS",
    "node /tmp/write-big.js",
    "ls -ls preview/big.mp4 preview/ignored.png",
    "git check-ignore -v preview/ignored.png",
    "echo large-fixtures-written",
    "",
  ].join("\n");

/** huge.mp4: the clip and a 2 GiB sparse `free` box, over Mend's 2 GiB raw preview cap. */
const hugeScript = () => {
  const write = [
    'const fs = require("fs");',
    'const clip = fs.readFileSync("preview/clip.mp4");',
    FREE_BOX,
    'const f = fs.openSync("preview/huge.mp4", "w"); fs.writeSync(f, clip); fs.writeSync(f, free(2 ** 31));',
    "fs.ftruncateSync(f, clip.length + 16 + 2 ** 31); fs.closeSync(f);",
  ].join(" ");
  return [
    "set -e",
    `node -e '${write}'`,
    "ls -ls preview/huge.mp4",
    "echo huge-fixture-written",
    "",
  ].join("\n");
};

/** Every terminal status a terminal call or the metadata stream carries, with its thread. */
const terminalStatesOf = (value) => {
  const terminals = [
    value?.status && value?.terminalId ? { ...value, kind: "result" } : null,
    value?.snapshot?.status ? { ...value.snapshot, kind: value.type } : null,
    value?.type === "exited" || value?.type === "closed"
      ? { threadId: value.threadId, status: value.type, kind: "event" }
      : null,
    value?.terminal?.status ? { ...value.terminal, kind: value.type } : null,
    ...(Array.isArray(value?.terminals)
      ? value.terminals.map((terminal) => ({ ...terminal, kind: value.type }))
      : []),
  ];
  return terminals
    .filter((terminal) => terminal !== null)
    .map(({ threadId, status, kind }) => ({ threadId, status, kind }));
};

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

/** The first readable message in an Effect RPC failure cause. */
const failureMessage = (cause) => {
  const text = JSON.stringify(cause ?? null);
  const message = /"message":"((?:[^"\\]|\\.)*)"/.exec(text);
  return message ? JSON.parse(`"${message[1]}"`) : text.slice(0, 200);
};

/** Each thread's settle and snooze fields, from any shell value that carries a thread. */
const collectThreads = (value, threads) => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectThreads(entry, threads);
    return;
  }
  if (typeof value.id === "string" && ("settledAt" in value || "snoozedUntil" in value))
    threads.set(value.id, {
      settledAt: value.settledAt ?? null,
      snoozedUntil: value.snoozedUntil ?? null,
      snoozedAt: value.snoozedAt ?? null,
    });
  for (const child of Object.values(value)) collectThreads(child, threads);
};

/** The real client's project-by-name and per-person scratch flows, driven on 2026-10-30. */
async function scratchProjects({ page, web, capture, note, api, ok, until, registerSecret, mend }) {
  const projects = async () => (await api("/api/projects")).body;
  const home = async () => {
    await page.goto(web);
    await page.getByRole("textbox", { name: "Message" }).waitFor();
  };
  const palette = async () => {
    await home();
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder("Search commands, projects, and threads...").waitFor();
  };
  const withoutProject = async () => {
    await palette();
    await page.getByRole("option", { name: /New thread without a project/ }).click();
    await page.getByRole("combobox").filter({ hasText: "No project" }).waitFor();
  };
  const create = async (name, expected) => {
    await palette();
    await page.getByRole("option", { name: "New project", exact: true }).click();
    await page.getByPlaceholder("Project name").fill(name);
    await capture(`project-${expected}-before`);
    await page.getByRole("button", { name: /^Create \(/ }).click();
    const project = await until(`${expected} in Mend`, async () =>
      (await projects()).find((candidate) => candidate.name === expected),
    );
    ok(
      project.visibility === "private" &&
        project.defaultBranch === "main" &&
        project.originUrl === null,
      `${expected} · private · main · no origin URL (via api)`,
    );
    note(`project · ${JSON.stringify(project)}`);
    await capture(`project-${expected}-after`);
    return project;
  };
  const launch = async (project, prompt, evidence) => {
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await capture(`${evidence}-before`);
    await page.getByRole("button", { name: "Submit message", exact: true }).click();
    const session = await until(
      `Mend session for ${prompt}`,
      async () => (await api("/api/sessions")).body.find((candidate) => candidate.label === prompt),
      90_000,
    );
    await page.getByRole("main").getByRole("heading", { name: prompt, exact: true }).waitFor();
    ok(
      session.projectId === project.id && session.baseRef === "main" && !!session.worktreeId,
      `${evidence} · session ${session.id} · worktree ${session.worktreeId} · base main`,
    );
    const branches = await api(`/api/projects/${project.id}/branches`);
    ok(
      branches.body.some((branch) => branch.name === "main" && branch.sha === session.baseSha),
      `${evidence} · worktree base matches the project's main`,
    );
    note(`session · ${JSON.stringify(session)}`);
    note(`thread · ${page.url()}`);
    note(`project-detail · ${JSON.stringify(await api(`/api/projects/${project.id}`))}`);
    await capture(`${evidence}-after`);
    return session;
  };

  if (process.env.MEND_VERIFY_T3_SCRATCH === "member") {
    const manifest = JSON.parse(readFileSync(join(P, "scratch-projects.json"), "utf8"));
    const before = await projects();
    note(`member-projects-before · ${JSON.stringify(before)}`);
    ok(
      !before.some((project) => manifest.privateProjectIds.includes(project.id)),
      "second member cannot list the first person's private projects",
    );
    for (const id of manifest.privateProjectIds) {
      const result = await api(`/api/projects/${id}`);
      note(`member-project-read · ${JSON.stringify({ id, ...result })}`);
      ok(result.status === 404, `second member reads private project ${id} · HTTP 404`);
    }
    await home();
    await page
      .getByRole("navigation", { name: "Threads", exact: true })
      .getByRole("combobox", { name: "Filter threads by project" })
      .click();
    await capture("member-sidebar");
    await withoutProject();
    const own = await until("second member's scratch project", async () =>
      (await projects()).find((project) => project.scratchOwnerUserId !== null),
    );
    ok(
      own.name === "scratch-second-verifier" &&
        own.visibility === "private" &&
        own.organizationId === manifest.organizationId &&
        !manifest.privateProjectIds.includes(own.id),
      "second member has their own private scratch-second-verifier in the same organization",
    );
    note(`member-scratch · ${JSON.stringify(own)}`);
    await capture("member-no-project");
    await page.reload();
    await page.getByRole("textbox", { name: "Message" }).waitFor();
    const after = await projects();
    note(`member-projects-after-reload · ${JSON.stringify(after)}`);
    ok(
      after.filter((project) => project.scratchOwnerUserId !== null).length === 1,
      "second member still has one scratch project after reload",
    );
    return;
  }

  ok(process.env.MEND_VERIFY_T3_SCRATCH === "owner", "scratch recipe mode is owner or member");
  const before = await projects();
  ok(
    !before.some((project) => project.name === "my-notes" || project.scratchOwnerUserId !== null),
    "fresh project creation baseline",
  );
  note(`git-author · ${JSON.stringify(await api("/api/me/git-author"))}`);
  await palette();
  await page.getByRole("option", { name: "New project", exact: true }).waitFor();
  await capture("scratch-new-project-command");
  await page.getByRole("option", { name: "New thread in...", exact: true }).click();
  await page.getByRole("option", { name: /No project/ }).waitFor();
  await capture("scratch-no-project-choice");
  ok(true, "New project and No project are offered after pairing");

  const named = await create("My Notes", "my-notes");
  const collision = await create("My Notes", "my-notes-2");
  ok(
    (await projects()).some((project) => project.id === named.id),
    "my-notes and my-notes-2 both exist",
  );
  await page
    .getByRole("navigation", { name: "Threads", exact: true })
    .getByRole("combobox", { name: "Filter threads by project" })
    .click();
  await page.getByRole("option", { name: "my-notes", exact: true }).waitFor();
  await page.getByRole("option", { name: "my-notes-2", exact: true }).waitFor();
  await capture("scratch-sidebar-projects");
  await page.keyboard.press("Escape");
  const stamp = new Date().toISOString();
  await launch(collision, `Named project verification ${stamp}`, "named-thread");

  await withoutProject();
  const scratch = await until("first person's scratch project", async () =>
    (await projects()).find((project) => project.scratchOwnerUserId !== null),
  );
  ok(
    scratch.name === "scratch-verifier" &&
      scratch.visibility === "private" &&
      scratch.createdByUserId === scratch.scratchOwnerUserId,
    "No project resolves to the paired person's private scratch-verifier",
  );
  note(`scratch-project · ${JSON.stringify(scratch)}`);
  const first = await launch(scratch, `Scratch verification 1 ${stamp}`, "scratch-thread-1");
  await withoutProject();
  const reused = (await projects()).filter((project) => project.scratchOwnerUserId !== null);
  ok(reused.length === 1 && reused[0].id === scratch.id, "No project reuses the same project");
  const second = await launch(scratch, `Scratch verification 2 ${stamp}`, "scratch-thread-2");
  ok(first.worktreeId !== second.worktreeId, "two scratch sessions use two different worktrees");
  await palette();
  await page.getByRole("option", { name: "New thread in...", exact: true }).click();
  await capture("scratch-picker");
  ok(
    !(await page.getByRole("dialog", { name: "Command palette" }).innerText()).includes(
      scratch.name,
    ),
    "new-thread project picker offers No project and omits scratch-verifier",
  );
  const path = await create("../../var/tmp/verify-no-open", "var-tmp-verify-no-open");
  ok(
    path.storePath.includes(`/${path.id}/repo.git`),
    "path-shaped name is a slug in Mend's central store",
  );
  await home();
  await capture("scratch-final-sidebar");
  writeFileSync(
    join(P, "scratch-projects.json"),
    JSON.stringify({
      organizationId: named.organizationId,
      privateProjectIds: [named.id, collision.id, scratch.id, path.id],
    }),
    { mode: 0o600 },
  );

  // Setup for a separate fresh-browser member pass; credentials never enter the evidence.
  const invitation = await api("/api/organization/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "member" }),
  });
  ok(invitation.status === 200, "second member invitation minted on the stack");
  registerSecret("scratch-member-invitation", invitation.body.token);
  const email = `scratch-second-${randomBytes(6).toString("hex")}@verify.invalid`;
  const password = `verify-${randomBytes(24).toString("hex")}`;
  registerSecret("scratch-member-password", password);
  const signUp = await fetch(`${mend}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      origin: mend,
      "content-type": "application/json",
      "x-mend-invitation": invitation.body.token,
    },
    body: JSON.stringify({ name: "Second Verifier", email, password }),
  });
  const token = signUp.headers.get("set-auth-token");
  if (token) registerSecret("scratch-member-token", token);
  ok(signUp.ok && !!token, `second member joined · HTTP ${signUp.status}`);
  writeFileSync(join(P, "scratch-member.json"), JSON.stringify({ email, password, token }), {
    mode: 0o600,
  });
}

/** Removal dialogs in the hosted v0.1.2 client, driven on 2026-10-30. */
async function removalChecks({ page, web, capture, note, api, ok, until, rpc }) {
  const mode = process.env.MEND_VERIFY_T3_REMOVAL;
  const projectName = process.env.MEND_VERIFY_T3_REMOVAL_PROJECT ?? "verify-fixture";
  const home = async () => {
    await page.goto(web);
    await page.getByRole("textbox", { name: "Message" }).waitFor();
  };
  // These decorative paths trip the driver's QR heuristic. This is the same omission used by
  // previewShot above; capture still checks the entire remaining document for credentials.
  const shot = async (name) => {
    const removed = await page
      .locator('#t3code-pierre-file-icon-sprite svg, svg[viewBox="0 0 256 257"]')
      .evaluateAll((nodes) => {
        for (const node of nodes) node.remove();
        return nodes.length;
      });
    note(`observed · omitted ${removed} decorative SVGs before ${name}`);
    await capture(name);
  };
  const projects = async () => (await api("/api/projects")).body;

  if (mode === "race") {
    const project = (await projects()).find((item) => item.name === projectName);
    ok(!!project, `race project ${projectName} exists`);
    const created = await api(`/api/projects/${project.id}/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `removal-race-${randomBytes(4).toString("hex")}`, base: null }),
    });
    ok(created.status === 200, "race worktree created through Mend's API");
    const id = created.body.id;
    const removal = api(`/api/worktrees/${id}`, { method: "DELETE" });
    await page.waitForTimeout(0);
    const start = await api(`/api/worktrees/${id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "run", label: "removal-race-session" }),
    });
    note(`race-start · ${JSON.stringify(start)}`);
    note(`race-removal · ${JSON.stringify(await removal)}`);
    ok(start.status !== 500, "racing start did not return 500");
    note(
      start.status === 409 && start.body._tag === "RemovalInProgress"
        ? "observed · typed 409 RemovalInProgress"
        : "not observed · the start missed the removal fence; retain both answers",
    );
    return;
  }

  if (mode === "project-blocked" || mode === "project-remove") {
    const project = (await projects()).find((item) => item.name === projectName);
    ok(!!project, `project ${projectName} exists before removal`);
    await home();
    await page.getByRole("combobox", { name: "Filter threads by project", exact: true }).click();
    await page.getByRole("option", { name: projectName, exact: true }).click({ button: "right" });
    await shot(`${mode}-before`);
    await page.getByRole("button", { name: "Remove project", exact: true }).click();
    await shot(`${mode}-confirm`);
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    if (mode === "project-blocked") {
      await until("project mutation refusal", () =>
        rpc.failures.some((failure) => failure.tag === "projects.mutate"),
      );
      await shot("project-refused");
      note(`client-visible · ${await page.locator("body").innerText()}`);
      const result = await api(`/api/projects/${project.id}`, { method: "DELETE" });
      note(`project-refusal-api · ${JSON.stringify(result)}`);
      ok(result.status === 409 && result.body._tag === "RemovalRefused", "project kept by Mend");
      return;
    }
    await until(
      "project removed in Mend",
      async () => {
        const result = await api(`/api/projects/${project.id}`);
        note(`project-after · ${JSON.stringify(result)}`);
        return result.status === 404;
      },
      120_000,
    );
    for (const name of ["project-absent", "project-absent-after-reload"]) {
      if (name.endsWith("reload")) await page.reload();
      else await home();
      await page.getByRole("textbox", { name: "Message" }).waitFor();
      await page.getByRole("combobox", { name: "Filter threads by project", exact: true }).click();
      await shot(name);
      ok(
        (await page.getByRole("option", { name: projectName, exact: true }).count()) === 0,
        `${name} · client picker omits ${projectName}`,
      );
      await page.keyboard.press("Escape");
    }
    note(`projects-after-reload · ${JSON.stringify(await projects())}`);
    return;
  }

  ok(["clean", "no-origin", "owner", "live"].includes(mode), "known removal drive mode");
  const label = process.env.MEND_VERIFY_T3_REMOVAL_THREAD ?? `removal-${mode}`;
  await home();
  if (mode === "clean") {
    await page.waitForTimeout(3000);
    await page.getByRole("textbox", { name: "Message" }).fill(label);
    await shot("clean-before-launch");
    await page.getByRole("button", { name: "Submit message", exact: true }).click();
    await page.getByText("Failed to authenticate").first().waitFor({ timeout: 180_000 });
  } else {
    await page.getByRole("button", { name: new RegExp(`^${label},`) }).click();
  }
  const session = await until("Mend session for removal", async () =>
    (await api("/api/sessions")).body.find((item) => item.label === label),
  );
  const id = session.worktreeId;
  note(`removal-session · ${JSON.stringify(session)}`);
  note(`worktree-before · ${JSON.stringify(await api(`/api/worktrees/${id}`))}`);
  if (mode === "owner" || mode === "live") {
    const refused = await api(`/api/worktrees/${id}`, { method: "DELETE" });
    note(`worktree-refusal-api · ${JSON.stringify(refused)}`);
    ok(
      mode === "owner"
        ? refused.status === 403 && refused.body._tag === "RemovalForbidden"
        : refused.status === 409 && refused.body._tag === "RemovalRefused",
      `${mode} refusal from Mend's API`,
    );
  }
  await shot(`${mode}-before-delete`);
  await page.getByRole("button", { name: /^Thread actions for/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Delete the worktree too?" }).waitFor();
  await shot(`${mode}-worktree-confirm`);
  const since = Date.now();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  if (mode === "clean") {
    await until(
      "clean worktree gone",
      async () => {
        const result = await api(`/api/projects/${session.projectId}/worktrees`);
        note(`worktrees-after · ${JSON.stringify(result)}`);
        return result.status === 200 && !result.body.worktrees.some((item) => item.id === id);
      },
      120_000,
    );
    note(`observed · worktree absent ${Date.now() - since} ms after confirmation`);
    ok(
      (await page.locator("li[data-thread-item]").filter({ hasText: label }).count()) === 0,
      "clean thread absent from the client",
    );
    await shot("clean-removed");
    return;
  }
  await until(
    "worktree cleanup refusal",
    () => rpc.failures.some((failure) => failure.tag === "vcs.removeWorktree"),
    90_000,
  );
  await shot(`${mode}-refused`);
  const visible = await page.locator("body").innerText();
  note(`client-visible · ${visible}`);
  note(`rpc-refusals · ${JSON.stringify(rpc.failures)}`);
  note(`worktree-retained · ${JSON.stringify(await api(`/api/worktrees/${id}`))}`);
  if (mode === "no-origin") {
    const expected =
      "This worktree has work that is not on any remote. Remove it from Mend if you mean to discard it.";
    ok(
      rpc.failures.some(
        (failure) => failure.tag === "vcs.removeWorktree" && failure.message === expected,
      ),
      "no-origin refusal matches byte-for-byte",
    );
    ok(visible.includes(expected), "client visibly includes the exact no-origin sentence");
    const file = await api(`/api/worktrees/${id}/contents?path=discard-proof.txt`);
    note(`file-retained · ${JSON.stringify(file)}`);
    ok(file.body.file.contents === "keep this work\n", "no-origin file retains its contents");
  }
}

/** Restorable projects through the hosted v0.1.2 client, driven on 2026-10-30. */
async function retentionProjects({ page, web, capture, note, api, ok, until, descriptor }) {
  const mode = process.env.MEND_VERIFY_T3_RETENTION;
  const name = process.env.MEND_VERIFY_T3_RETENTION_PROJECT ?? "verify-fixture";
  const projects = async () => (await api("/api/projects")).body;
  const shot = async (label) => {
    // Decorative icon paths match the driver's QR heuristic; retain its other capture checks.
    await page
      .locator('#t3code-pierre-file-icon-sprite svg, svg[viewBox="0 0 256 257"]')
      .evaluateAll((nodes) => {
        for (const node of nodes) node.remove();
      });
    await capture(label);
  };
  const home = async () => {
    await page.goto(web);
    await page.getByRole("textbox", { name: "Message" }).waitFor();
  };
  if (mode === "absent" || mode === "restored") {
    await page.goto(web);
    await page.waitForTimeout(2000);
    await page.getByRole("combobox", { name: "Filter threads by project", exact: true }).click();
    await shot(`retention-${mode}-picker`);
    const count = await page.getByRole("option", { name, exact: true }).count();
    ok(count === (mode === "absent" ? 0 : 1), `${mode} · ${name} option count ${count}`);
    return;
  }
  if (mode === "scratch-restore") {
    const removed = (await api("/api/removed-projects")).body.find(
      (project) => project.name === name && project.state === "removed",
    );
    ok(!!removed, `removed scratch ${name} exists`);
    const result = await api(`/api/removed-projects/${removed.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${name}-restored` }),
    });
    note(`scratch-restored-renamed · ${JSON.stringify(result)}`);
    ok(
      result.status === 200 &&
        result.body.scratchOwnerUserId === null &&
        result.body.visibility === "private",
      "old scratch restores as a plain private project with its new name",
    );
    await home();
    await page.getByRole("combobox", { name: "Filter threads by project", exact: true }).click();
    await page.getByRole("option", { name: `${name}-restored`, exact: true }).waitFor();
    await shot("retention-scratch-restored-plain-project");
    return;
  }
  ok(mode === "scratch", "known retention drive mode");
  const withoutProject = async () => {
    await home();
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder("Search commands, projects, and threads...").waitFor();
    await page.getByRole("option", { name: /New thread without a project/ }).click();
    await page.getByRole("combobox").filter({ hasText: "No project" }).waitFor();
  };
  await withoutProject();
  const old = await until("old scratch", async () =>
    (await projects()).find((project) => project.scratchOwnerUserId !== null),
  );
  note(`scratch-before · ${JSON.stringify(old)}`);
  await shot("retention-scratch-before");
  const root = `/__mend__/people/${Buffer.from(old.scratchOwnerUserId, "utf8").toString("hex")}/scratch`;
  await page.goto(
    `${web}/settings/projects?project=${encodeURIComponent(`${descriptor.environmentId}:${root}`)}`,
  );
  await page.getByRole("button", { name: "Remove project", exact: true }).click();
  await shot("retention-scratch-confirm");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await until("scratch removed", async () => (await api(`/api/projects/${old.id}`)).status === 404);
  note(`scratch-removed · ${JSON.stringify(await api("/api/removed-projects"))}`);
  await withoutProject();
  const next = await until("new scratch", async () =>
    (await projects()).find((project) => project.scratchOwnerUserId !== null),
  );
  ok(next.id !== old.id, "next No project creates another scratch project");
  note(`scratch-next · ${JSON.stringify(next)}`);
  await shot("retention-scratch-new");
}
