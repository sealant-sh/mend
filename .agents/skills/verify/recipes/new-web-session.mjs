// The session sheet of the new web app (apps/web, route PR 11, SLNT-1119): a session opens at its
// own address as its workspace's sheet, with the Workspace header and one tile whose tab is the
// conversation; under 1024px the Phone header and one strip of tabs. Run the CLI batch first, once
// per stack: it starts real sessions on the stack.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-session-sessions.json
//   pnpm verify drive new-web --recipe new-web-session
//
// Feature ids: start-session.md `session-page` (the page, its status, its record and checkpoints),
// observed-agents.md `observe-running` (a running session reads running), dotfiles.md
// `dotfiles-session-line`, agent-memory.md `memory-pre-release-note`, workspace-images.md
// `image-build-state` and secret-files.md's line come from the session's own facts and summary.
// A local stack runs no agent (tooling/verify/local-stack-limits.json, `real-agent-turn`), so the
// states only an agent's turn makes (the turn that completes, out of credit, the live line, a
// session that is starting or couldn't start) are drawn from fixture answers to the session's
// reads, laid over real sessions; every capture taken that way is named `fixture-…`.
import {
  command,
  empty,
  history,
  item,
  patchDetail,
  superjson,
  turn,
} from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  /** Captures the page in light and dark, on a desktop and at phone width, as it stands. */
  const everywhere = async (name) => {
    for (const [viewport, size] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      await page.setViewportSize(size);
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        await capture(`${name}-${viewport}-${theme}`);
      }
    }
    await setTheme("light");
    await page.setViewportSize(DESKTOP);
  };
  const router = () => page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  /** React has taken the page over: a click reaches its controls. */
  const hydrated = async () => {
    await router();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href]")].some((link) =>
        Object.keys(link).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  /** Moves through the router, as a click on a link would: the browser reads what isn't held. */
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ href: to }), path);
  const tile = () => visible(page.getByRole("tablist"));
  const tab = () => visible(page.getByRole("tab"));
  const pathname = () => new URL(page.url()).pathname;

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The sessions the CLI batch started, by the name each was given.
  const rows = await page.evaluate(async () => {
    const client = window["__TSR_ROUTER__"].options.context.queryClient;
    await client.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return client.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state.data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const idOf = (name) => {
    const row = rows.find((each) => each.title === name || each.worktreeName === name);
    if (row === undefined) throw new Error(`no session named ${name}: run the CLI batch first`);
    return row.session.id;
  };
  const failureOf = (name) =>
    rows.find((each) => each.title === name || each.worktreeName === name)?.failure ?? null;
  const ids = Object.fromEntries(
    [
      "session-record",
      "session-failed",
      "session-turn",
      "session-credit",
      "session-start-failed",
      "session-starting",
      "session-running",
    ].map((name) => [name, idOf(name)]),
  );

  // session-page: a real session, read on the server, at its own address.
  await open(`/sessions/${ids["session-record"]}`);
  await visible(page.getByRole("heading", { level: 1 })).waitFor();
  const header = await visible(page.getByRole("heading", { level: 1 })).innerText();
  if (!header.includes("verify-fixture") || !header.includes("session-record"))
    throw new Error(`the Workspace header reads "${header}"`);
  const vscode = await page.getByRole("link", { name: "Open in VS Code" }).getAttribute("href");
  if (vscode !== `vscode://sealant-sh.mend/open?session=${ids["session-record"]}`)
    throw new Error(`Open in VS Code goes to ${vscode}`);
  const tabName = (await tab().getAttribute("aria-label")) ?? "";
  const selected = await tab().getAttribute("aria-selected");
  if (selected !== "true") throw new Error("the conversation tab is not the active one");
  note(
    `session-page: the header reads "${header.replace(/\s+/g, " ")}", the one tab "${tabName.replace(/\s+/g, " ")}" is active, Open in VS Code is ${vscode}`,
  );
  await visible(page.getByText("Ran", { exact: true }))
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  await everywhere("record");

  // Phone: the Phone header's Back goes to the inbox, which is home there.
  await page.setViewportSize(PHONE);
  await visible(page.getByRole("link", { name: "Back to the inbox" })).click();
  await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
  if (pathname() !== "/") throw new Error(`Back went to ${page.url()}`);
  note("phone: Back to the inbox goes to /, the inbox");
  await page.setViewportSize(DESKTOP);

  // observe-running: a session whose agent runs reads Running on its tab.
  await open(`/sessions/${ids["session-running"]}`);
  const running = (await tab().getAttribute("aria-label")) ?? "";
  if (!/Running/.test(running)) throw new Error(`the running session's tab reads "${running}"`);
  note(`observe-running: the running session's tab reads "${running.replace(/\s+/g, " ")}"`);
  await everywhere("running");

  // A session that failed after its command ran: the reason the inbox row shows.
  await open(`/sessions/${ids["session-failed"]}`);
  await visible(page.getByText("The session failed", { exact: true })).waitFor();
  const failure = failureOf("session-failed");
  if (failure !== null) await visible(page.getByText(failure, { exact: true })).waitFor();
  note(`a failed session says why, in the words its inbox row shows: "${failure}"`);
  await everywhere("failed");

  // Old links keep working.
  await open(`/sessions/${ids["session-record"]}?view=desktop`);
  if (pathname() !== `/sessions/${ids["session-record"]}` || page.url().includes("view="))
    throw new Error(`?view=desktop went to ${page.url()}`);
  await open(`/sessions/${ids["session-record"]}?full=1`);
  await tile().waitFor();
  await open(`/sessions/${ids["session-record"]}#checkpoint-1`);
  await page.waitForURL(`**/sessions/${ids["session-record"]}/record#checkpoint-1`);
  await open("/starting/a-draft-from-before");
  if (pathname() !== "/") throw new Error(`/starting/<draft> went to ${page.url()}`);
  note(
    "old links: ?view=desktop lands on the session without it, ?full=1 opens the session, #checkpoint-1 opens its Record, /starting/<draft> goes home",
  );

  // Fixtures: what an agent's turn makes, laid over the real sessions' reads in the browser.
  await open("/no-such-page");
  const me = await page.evaluate(
    () =>
      window["__TSR_ROUTER__"].options.context.queryClient
        .getQueryCache()
        .findAll({ queryKey: [["organization", "current"]] })[0]?.state.data?.userId,
  );
  if (typeof me !== "string") throw new Error("the page holds no signed-in account");
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const conversations = {
    [ids["session-turn"]]: turnCompletes(ids["session-turn"], me, at),
    [ids["session-credit"]]: outOfCredit(ids["session-credit"], me, at),
    [ids["session-running"]]: working(ids["session-running"], me, at),
    [ids["session-start-failed"]]: empty(),
    [ids["session-starting"]]: empty(),
    [ids["session-record"]]: published(ids["session-record"], me, at),
  };
  // The page the published fixture's turn made, and the session's Executor calls.
  const pageId = "fixture-page-1";
  const pagesOf = {
    [ids["session-record"]]: superjson(
      [
        {
          id: pageId,
          sessionId: ids["session-record"],
          title: "Refund retries",
          height: 220,
          publishedAt: at(5),
        },
      ],
      ["0.publishedAt"],
    ),
  };
  const callsOf = {
    [ids["session-record"]]: executorCalls(ids["session-record"], me, at),
  };
  const sessionPatches = {
    [ids["session-turn"]]: { status: "completed", harness: "claude" },
    [ids["session-credit"]]: { status: "failed", summary: null, harness: "claude" },
    [ids["session-running"]]: { status: "running", harness: "claude" },
    [ids["session-record"]]: { status: "completed", harness: "claude" },
    [ids["session-start-failed"]]: {
      status: "failed",
      summary:
        "pnpm couldn't download @northwind/ledger-client. Check the registry token in verify-fixture's workspace settings, then try again.",
      sealantRunId: null,
      harness: "claude",
      dropAgent: true,
    },
    [ids["session-starting"]]: {
      status: "starting",
      summary: "building the workspace image · step 3/12",
      sealantRunId: null,
      harness: "claude",
      dropAgent: true,
    },
  };
  let failReads = false;
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    // The app's tRPC client sends every call as a POST: the inputs are in the body.
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const mine = paths.map((path, index) => {
      const id = inputs[String(index)]?.json?.id;
      if (path.startsWith("sessions.history") && failReads) return "fail";
      if (path.startsWith("sessions.history") && conversations[id] !== undefined) return "history";
      if (path === "sessions.detail" && sessionPatches[id] !== undefined) return "detail";
      if (path === "sessions.pages" && pagesOf[id] !== undefined) return "pages";
      if (path === "pages.frame" && id === pageId) return "frame";
      const sessionId = inputs[String(index)]?.json?.sessionId;
      if (path === "executor.calls" && callsOf[sessionId] !== undefined) return "calls";
      return null;
    });
    if (mine.every((each) => each === null)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    paths.forEach((path, index) => {
      const id = inputs[String(index)]?.json?.id;
      if (mine[index] === "fail")
        answers[index] = {
          error: {
            json: {
              message: "The verify recipe failed this read on purpose.",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path },
            },
          },
        };
      else if (mine[index] === "history")
        answers[index] = { result: { data: conversations[id][path] } };
      else if (mine[index] === "pages") answers[index] = { result: { data: pagesOf[id] } };
      else if (mine[index] === "frame")
        answers[index] = {
          result: {
            data: superjson(
              {
                url: `${web}/__fixture-page.html`,
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
              },
              ["expiresAt"],
            ),
          },
        };
      else if (mine[index] === "calls")
        answers[index] = {
          result: { data: callsOf[inputs[String(index)].json.sessionId] },
        };
      else if (mine[index] === "detail")
        answers[index] = {
          result: { data: patchDetail(answers[index].result.data, sessionPatches[id]) },
        };
    });
    await route.fulfill({
      response,
      status: failReads ? 207 : response.status(),
      json: Array.isArray(body) ? answers : answers[0],
    });
  });
  const fixture = async (name, path, ready) => {
    await open("/no-such-page");
    await go(path);
    await ready();
    await everywhere(`fixture-${name}`);
  };

  // The turn completes (Doop RJjUoFjOeI): turn 3's header, Worked for … folded, what it wrote.
  await fixture("turn-completes", `/sessions/${ids["session-turn"]}`, async () => {
    await visible(page.getByText("· turn 3", { exact: false })).waitFor();
    await visible(page.getByText(/^Worked for/)).waitFor();
  });
  await visible(page.getByRole("button", { name: /^Worked for/ })).click();
  await visible(page.getByText("pnpm test --filter checkout")).waitFor();
  note(
    "fixture turn completes: turn 3's header, Worked for 2 min 4 s with 3 steps · 1 failed, opened to its steps",
  );
  // The fold opens with an animation: capture it open.
  await settled();
  await capture("fixture-turn-steps-desktop-light");

  // Out of credit (Doop 4SRZGM5MQX): why the turn stopped, the agent's words, Open agent logins.
  await fixture("out-of-credit", `/sessions/${ids["session-credit"]}`, async () => {
    await visible(page.getByText(/ran out of credit$/)).waitFor();
  });
  await visible(page.getByRole("link", { name: "Open agent logins" })).waitFor();
  note("fixture out of credit: the reason, the error in mono, Open agent logins and Copy error");

  // A turn under way: the live line says what the agent is doing.
  await fixture("working", `/sessions/${ids["session-running"]}`, async () => {
    await visible(page.getByText("Running pnpm test…", { exact: true })).waitFor();
  });
  note("fixture working: the live line reads Running pnpm test…");

  // Starting (image-build-state) and starting failed (Doop 6m1iuNFm9-).
  await fixture("starting", `/sessions/${ids["session-starting"]}`, async () => {
    await visible(
      page.getByText("Getting the session ready · building the workspace image · step 3/12"),
    ).waitFor();
  });
  note("fixture starting: Getting the session ready · building the workspace image · step 3/12");
  await fixture("start-failed", `/sessions/${ids["session-start-failed"]}`, async () => {
    await visible(page.getByText("The session couldn't start.")).waitFor();
  });
  note("fixture start failed: the banner says the session couldn't start, and why");

  // A page the agent published, and its Executor calls. The page is a fixture document that does what
  // t3code's bootstrap does: it takes the host's theme from its address and reports its height.
  await page.route("**/__fixture-page.html", (route) =>
    route.fulfill({ contentType: "text/html", body: FIXTURE_PAGE }),
  );
  await fixture("published", `/sessions/${ids["session-record"]}`, async () => {
    await visible(page.getByRole("region", { name: "Executor calls" })).waitFor();
    await visible(page.getByText("linear · save_issue", { exact: true })).waitFor();
    await page
      .frameLocator('iframe[title="Refund retries"]')
      .getByText("Refund retries, by attempt")
      .waitFor({ timeout: 30_000 });
  });
  await visible(page.getByText("linear · save_issue", { exact: true })).click();
  await visible(page.getByText("Waiting for you to answer in Mend.")).waitFor();
  const frameHeight = await page
    .locator('iframe[title="Refund retries"]')
    .first()
    .evaluate((frame) => frame.getBoundingClientRect().height);
  note(
    `fixture published: the Executor calls list two calls, one waiting for you; the page Refund retries renders in its frame at ${Math.round(frameHeight)}px, its own height`,
  );
  await visible(page.getByRole("button", { name: "Open Refund retries" })).click();
  await page.getByRole("dialog", { name: "Refund retries" }).waitFor();
  await page.waitForTimeout(800);
  await capture("fixture-page-open-desktop-light");
  await page.keyboard.press("Escape");
  note("Open shows the page large in a dialog, and Escape closes it");

  // The conversation's read fails: the failure with what the server said, and Try again.
  failReads = true;
  await open("/no-such-page");
  await go(`/sessions/${ids["session-turn"]}`);
  await visible(page.getByText(/^The conversation didn't load/)).waitFor({ timeout: 30_000 });
  await capture("conversation-failed-desktop-light");
  failReads = false;
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await visible(page.getByText("· turn 3", { exact: false })).waitFor();
  note("a failed conversation read says so with what the server said; Try again reads it again");
  await page.unroute("**/trpc/**");
};

const turnCompletes = (sessionId, me, at) => {
  const t1 = turn(
    sessionId,
    me,
    0,
    "completed",
    "Find why checkout fails 1 in 50 runs.",
    at(40),
    at(36),
  );
  const t2 = turn(sessionId, me, 1, "completed", "Add a test for the retry.", at(30), at(28));
  const t3 = turn(
    sessionId,
    me,
    2,
    "completed",
    "Checkout fails about 1 in 50 CI runs with a duplicate charge. Find out why and fix it without changing the public API.",
    at(20),
    at(17.93),
  );
  return history({
    turns: [t1, t2, t3],
    items: [
      item(t1.id, "assistant-message", "completed", at(37), at(37), {
        text: "The retry wrapper sends the charge again.",
      }),
      item(t2.id, "assistant-message", "completed", at(29), at(29), {
        text: "Added `retry.test.ts`.",
      }),
      command(t3.id, "completed", at(19.9), at(19.8), "rg -n idempotency src/checkout"),
      item(t3.id, "file-change", "completed", at(19.5), at(19.4), {
        title: "src/checkout/retry.ts",
      }),
      command(t3.id, "failed", at(19), at(18.5), "pnpm test --filter checkout"),
      item(t3.id, "assistant-message", "completed", at(18), at(18), {
        text: "After a 503, the retry wrapper sent the charge again without an idempotency key. If the first attempt was slow, the customer got charged twice. I added a key based on the order id, and the tests then passed 200 out of 200 times. Since then I've added `backoff()`, which hasn't been tested yet.",
      }),
    ],
  });
};

const outOfCredit = (sessionId, me, at) => {
  const t1 = turn(
    sessionId,
    me,
    0,
    "failed",
    "Also cover partial refunds. Each partial refund needs its own key, so two partial refunds on the same order can both go through.",
    at(12),
    at(11.3),
    {
      error:
        "API Error: 400 credit_balance_too_low\nYour credit balance is too low to access the Anthropic API.",
      billedAccountName: "ada@northwind.dev",
    },
  );
  return history({
    turns: [t1],
    items: [
      item(t1.id, "assistant-message", "completed", at(11.9), at(11.9), {
        text: "I'll add the partial refund's sequence number to the key. Two partial refunds on one order then get different keys, and a retry of either one still matches its first attempt.",
      }),
      item(t1.id, "file-change", "completed", at(11.6), at(11.5), {
        title: "src/refunds/partial-refund.ts",
      }),
    ],
  });
};

const working = (sessionId, me, at) => {
  const t1 = turn(
    sessionId,
    me,
    0,
    "running",
    "Run the checkout tests and fix what fails.",
    at(2),
    null,
  );
  return history({
    turns: [t1],
    items: [
      item(t1.id, "assistant-message", "completed", at(1.9), at(1.9), {
        text: "Running the tests first.",
      }),
      command(t1.id, "in-progress", at(1.5), at(1.5), "pnpm test"),
    ],
  });
};

const published = (sessionId, me, at) => {
  const t1 = turn(
    sessionId,
    me,
    0,
    "completed",
    "Chart refund retries by attempt and publish it as a page.",
    at(6),
    at(4.9),
  );
  return history({
    turns: [t1],
    items: [
      command(t1.id, "completed", at(5.8), at(5.6), "pnpm tsx scripts/retries.ts"),
      item(t1.id, "tool-call", "completed", at(5.2), at(5), {
        title: "mend_page",
        data: { mendPageCall: { attachmentId: "fixture-page-1", failure: null } },
      }),
      item(t1.id, "assistant-message", "completed", at(4.95), at(4.95), {
        text: "Published **Refund retries** above: most retries succeed on the second attempt.",
      }),
    ],
  });
};

const executorCalls = (sessionId, me, at) => {
  const call = (id, tool, outcome, message, approverId, minutes) => ({
    id,
    sessionId,
    service: "linear",
    tool,
    asUserId: me,
    asMember: false,
    approverId,
    outcome,
    message,
    observations: outcome === "completed" ? [{ service: "linear", tool, outcome: "ok" }] : [],
    createdAt: at(minutes),
    observedAt: at(minutes - 0.1),
    expiresAt: null,
  });
  const calls = [
    call("call-2", "save_issue", "held", "Executor holds this call until it is approved.", me, 3),
    call("call-1", "get_issue", "completed", "Read issue SLNT-1119.", null, 4),
  ];
  return superjson(
    { calls, olderCursor: null },
    calls.flatMap((_, index) => [`calls.${index}.createdAt`, `calls.${index}.observedAt`]),
  );
};

/** A page as t3code's bootstrap runs one: the host's theme from its address, its height posted. */
const FIXTURE_PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;font-family:var(--font-sans,sans-serif);background:var(--background);color:var(--foreground)">
<h2 style="margin:0 0 8px;font-size:15px">Refund retries, by attempt</h2>
<div style="display:flex;gap:6px;align-items:end;height:110px">${[90, 64, 22, 8]
  .map((h) => `<div style="width:40px;height:${h}px;background:var(--primary)"></div>`)
  .join("")}</div>
<p style="margin:8px 0 0;font-size:12px;color:var(--muted-foreground)">Attempts 1 to 4, share of refunds</p>
<script>
const raw = decodeURIComponent((location.hash.match(/t3-theme=([^&]*)/) || [])[1] || "");
try { const theme = JSON.parse(raw); for (const [k, v] of Object.entries(theme.variables || {})) document.documentElement.style.setProperty(k, v); } catch {}
addEventListener("message", (e) => { const v = e.data?.params?.styles?.variables; if (v) for (const [k, x] of Object.entries(v)) document.documentElement.style.setProperty(k, x); });
parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.body.scrollHeight } }, "*");
</script>`;
