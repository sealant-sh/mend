// The T3 gateway through a real t3code client (features/t3-gateway.md, "Through a t3code client"):
// the hosted web build of the pinned tag, paired with the run's gateway as a remote environment,
// driven the way a person uses it. Pair, launch a thread in a new worktree, a turn, a queue held by
// an interrupt and sent from with Send now (and Send now again from a second tab while that turn
// runs), snooze then settle, the terminal stopped and the page reloaded, the files and diff panels,
// the Files tab's previews of a worktree's raw files (an image, an SVG, a PDF, a video and its
// seeks, an HTML page and its stylesheet, a binary file), a pasted chat image, and the minted asset
// URLs refused once the client's device is revoked in Mend's web.
//
//   node .claude/skills/verify/scripts/serve-t3-client.mjs --dist <t3code>/apps/web/dist \
//     --port <client port> --gw <gateway> &
//   node .claude/skills/verify/scripts/drive-web.mjs --web http://127.0.0.1:<client port> \
//     --out <dir> --private "$P" --recipe .claude/skills/verify/recipes/t3-client.mjs --timeout 60000
//
// Needs the stack's account in $P/account.json (Launch, step 7) and a Claude login connected to the
// stack: the skill's fake one (`mend connect claude --from-stdin` with FAKES.claude), on which each
// turn starts and ends at once with Claude's own refusal. The browser starts empty: the client keeps
// its environments in IndexedDB, which --state does not carry, so the recipe pairs every run, and
// each run is a new `t3code · …` device in Mend. The previews need a co-located Mend
// (MEND_SESSION_STORE=colocated): the capture store answers every raw read with its 409 refusal,
// which the client shows as `Unable to load workspace image.` The fixtures are made here (ffmpeg on
// PATH for the MP4) and pasted into Mend's shell in the worktree. Revoking the device ends the run:
// every `t3code · T3 Code Web` device in Settings → Devices is revoked.
//
// Every `ok ·` line in steps.log is a step's observed end state; a line that does not hold fails
// the drive. `observed ·` lines record what was seen where the outcome is not fixed in advance
// (a race between two tabs, the client's own rendering). `rpc ·` lines are the client's own calls
// over /ws, read from its WebSocket frames: the gateway logs HTTP, not RPC. Mend's side is read
// through its API as the stack's account (`via api`), never acted on.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const P = process.env.MEND_VERIFY_PRIVATE;
const REFUSAL = "A queued user message can only be sent now while the thread is stopped.";
const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const HTML_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-downloads";

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const record = JSON.parse(readFileSync(join(P, "t3-client.json"), "utf8"));
  const mend = record.web;
  const gateway = record.gateway;
  const account = JSON.parse(readFileSync(join(P, "account.json"), "utf8"));
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
    const config = [`url = "${url}"`, ...headers.map((header) => `header = "${header}"`)];
    const result = spawnSync(
      "curl",
      ["-sS", "-o", "-", "-D", headerFile, ...(pathAsIs ? ["--path-as-is"] : []), "-K", "-"],
      { input: `${config.join("\n")}\n`, maxBuffer: 64 * 1024 * 1024 },
    );
    const lines = readFileSync(headerFile, "latin1").split(/\r?\n/);
    rmSync(headerFile, { force: true });
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
      sha256: result.stdout.length === 0 ? null : sha256(result.stdout),
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
  await main.getByRole("button", { name: "Refresh workspace files" }).click();
  await page.waitForTimeout(1500);
  await tree.getByRole("treeitem", { name: "verify-terminal.txt" }).waitFor();
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
  await toggleTerminal.click();
  await page.waitForTimeout(1500);
  if ((await terminalInput.count()) === 0) await toggleTerminal.click();
  await terminalInput.waitFor();
  await page.waitForTimeout(2000);
  const prompts = () => rpc.transcript.split("\u001b[?2004h").length;
  await terminalInput.focus();
  await page.keyboard.type("stty -echo; cat > /tmp/preview-fixtures.sh");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const script = fixtureScript(fixtures);
  for (let at = 0; at < script.length; at += 16_384)
    await terminalInput.evaluate(
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
  await page.keyboard.type("stty echo; sh /tmp/preview-fixtures.sh");
  await page.keyboard.press("Enter");
  await until("the fixture script's end", () =>
    rpc.transcript.includes("preview-fixtures-written"),
  );
  const digestsShown = rpc.transcript.replace(/\r/g, "");
  for (const [path, digest] of written)
    ok(
      digestsShown.includes(`${digest}  ${path}`),
      `${path} pasted through the terminal byte for byte (sha256 ${digest.slice(0, 12)})`,
    );
  await toggleTerminal.click();

  if (await files.isVisible()) await files.click();
  else {
    await main.getByRole("button", { name: "Add panel surface" }).click();
    await page.getByRole("menuitem", { name: /^Files/ }).click();
  }
  const folder = tree.getByRole("treeitem", { name: "preview" });
  await until("the Files panel lists preview/", async () => {
    await main.getByRole("button", { name: "Refresh workspace files" }).click();
    await page.waitForTimeout(1500);
    return (await folder.count()) > 0;
  });
  await folder.click();
  const open = async (name) => {
    const from = assets.length;
    await tree.getByRole("treeitem", { name }).click();
    return () => assets.slice(from).filter((entry) => entry.path.endsWith(`/${name}`));
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
  const decodes = (image, width) =>
    until(`the image decodes at ${width} px`, () =>
      image.evaluate((element, w) => element.complete && element.naturalWidth === w, width),
    );

  let served = await open("pixel.png");
  const png = main.locator('img[alt="preview/pixel.png"]');
  await decodes(png, 64);
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

  served = await open("logo.svg");
  await decodes(main.locator('img[alt="preview/logo.svg"]'), 96);
  ok(
    served().some(
      (entry) =>
        entry.status === 200 && entry.contentType === "image/svg+xml" && entry.csp === SVG_POLICY,
    ),
    `logo.svg previews, served with the sandbox CSP: ${JSON.stringify(served())}`,
  );
  await previewShot("16-preview-svg");

  served = await open("doc.pdf");
  const embed = main.locator("embed");
  await embed.waitFor({ state: "attached" });
  await page.waitForTimeout(3000);
  ok(
    (await embed.getAttribute("type")) === "application/pdf" && minted.has("doc.pdf"),
    "doc.pdf previews as an application/pdf embed of a URL the gateway minted",
  );
  note(
    `observed · doc.pdf · this Chromium's pdfViewerEnabled ${await page.evaluate(() => navigator.pdfViewerEnabled)} · the embed's fetches: ${JSON.stringify(served())}`,
  );
  await shot("17-preview-pdf");

  served = await open("clip.mp4");
  const video = main.locator("video");
  await until(
    "clip.mp4 loads its metadata",
    () => video.evaluate((element) => element.readyState >= 1 && element.duration > 9),
    30_000,
  );
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

  await open("site");
  const htmlServed = await open("index.html");
  const frameElement = main.locator("iframe");
  await frameElement.waitFor({ state: "attached" });
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
    "echo preview-fixtures-written",
    "",
  ].join("\n");

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
