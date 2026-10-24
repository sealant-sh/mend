// The T3 gateway through a real t3code client (features/t3-gateway.md, "Through a t3code client"):
// the hosted web build of the pinned tag, paired with the run's gateway as a remote environment,
// driven the way a person uses it. Pair, launch a thread in a new worktree, a turn, a queue held by
// an interrupt and sent from with Send now (and Send now again from a second tab while that turn
// runs), snooze then settle, the terminal stopped and the page reloaded, the files and diff panels.
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
// each run is a new `t3code · …` device in Mend.
//
// Every `ok ·` line in steps.log is a step's observed end state; a line that does not hold fails
// the drive. `observed ·` lines record what was seen where the outcome is not fixed in advance
// (a race between two tabs, the client's own rendering). `rpc ·` lines are the client's own calls
// over /ws, read from its WebSocket frames: the gateway logs HTTP, not RPC. Mend's side is read
// through its API as the stack's account (`via api`), never acted on.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const P = process.env.MEND_VERIFY_PRIVATE;
const REFUSAL = "A queued user message can only be sent now while the thread is stopped.";

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const record = JSON.parse(readFileSync(join(P, "t3-client.json"), "utf8"));
  const mend = record.web;
  const gateway = record.gateway;
  const { token } = JSON.parse(readFileSync(join(P, "account.json"), "utf8"));
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

  const calls = [...new Set(rpc.calls.values())].sort();
  note(`rpc · methods the client called: ${calls.join(", ")}`);
  const refused = new Map();
  for (const { tag, message } of rpc.failures) {
    if (/^\[(\{"_tag":"Interrupt","fiberId":\d+\},?)+\]$/.test(message)) continue;
    const key = `${tag} · ${message}`;
    refused.set(key, (refused.get(key) ?? 0) + 1);
  }
  for (const [key, count] of refused) note(`rpc · refused ×${count} · ${key}`);
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
