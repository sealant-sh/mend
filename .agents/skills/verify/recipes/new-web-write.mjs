// Writing to the agent from a session in the new web app (route PR 12, SLNT-1128): the composer
// in the conversation's footer, a message sent into your own running turn, Stop turn, a message
// that couldn't send with Try again, and "Ask before acting" in both composers' menus. Run the
// session recipe's CLI batch first, once per stack: it starts the real sessions this lays its
// fixtures over.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-session-sessions.json
//   pnpm verify drive new-web --recipe new-web-write
//
// A local stack runs no agent (tooling/verify/local-stack-limits.json, `real-agent-turn`), so the
// turns are fixture answers to the sessions' reads, and the sends and stops are answered in the
// browser; every capture taken that way is named `fixture-…`. new-web-write-box runs the same
// steps against a real agent on the box.
import {
  command,
  history,
  item,
  patchDetail,
  superjson,
  turn,
} from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const STEER = "Also cover partial refunds. Each partial refund needs its own key.";
const FAILING = "Add a test for two partial refunds on one order.";
const REFUSED = "Mend couldn't reach the session's agent. Check the session, then try again.";

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
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href],button")].some((node) =>
        Object.keys(node).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ href: to }), path);
  const field = (agent = "Claude Code") =>
    visible(page.getByRole("textbox", { name: `Message ${agent}` }));

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => {
    localStorage.setItem("mend-theme", "light");
    sessionStorage.clear();
  });

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
  const me = await page.evaluate(
    () =>
      window["__TSR_ROUTER__"].options.context.queryClient
        .getQueryCache()
        .findAll({ queryKey: [["organization", "current"]] })[0]?.state.data?.userId,
  );
  if (typeof me !== "string") throw new Error("the page holds no signed-in account");
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const ids = {
    writing: idOf("session-running"),
    steered: idOf("session-credit"),
    stopping: idOf("session-turn"),
    failing: idOf("session-record"),
    ended: idOf("session-failed"),
  };
  const conversations = {
    [ids.writing]: running(ids.writing, me, at, []),
    [ids.steered]: running(ids.steered, me, at, [
      {
        id: "fixture-steer-1",
        turnId: "fixture-turn-1",
        ordinal: 0,
        author: me,
        input: STEER,
        createdAt: at(0.2),
        delivery: { _tag: "Accepted", evidence: "transport-written" },
        clientMessageId: null,
      },
    ]),
    [ids.stopping]: running(ids.stopping, me, at, []),
    [ids.failing]: completed(ids.failing, me, at),
  };
  const live = { status: "running", harness: "claude", protocolAgent: true };
  const sessionPatches = {
    // Codex here: the driver withholds a picture of any filled field whose label says "Code", as
    // "Message Claude Code" does, so the words being written show under Codex's name.
    [ids.writing]: { ...live, harness: "codex" },
    [ids.steered]: live,
    [ids.stopping]: live,
    [ids.failing]: live,
  };
  /** How the browser answers a send: refused in words, or taken as the next turn. */
  let sends = "refuse";
  const sent = [];
  const stops = [];
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const mine = paths.map((path, index) => {
      const id = inputs[String(index)]?.json?.id;
      if (path.startsWith("sessions.history") && conversations[id] !== undefined) return "history";
      if (path === "sessions.detail" && sessionPatches[id] !== undefined) return "detail";
      if (path === "sessions.sendMessage") return "send";
      if (path === "sessions.interruptTurn") return "stop";
      return null;
    });
    if (mine.every((each) => each === null)) return route.continue();
    const real = mine.some((each) => each === "history" || each === "detail");
    const response = real ? await route.fetch() : null;
    const body = response === null ? null : await response.json();
    const answers = body === null ? paths.map(() => null) : Array.isArray(body) ? body : [body];
    let refused = false;
    paths.forEach((path, index) => {
      const input = inputs[String(index)]?.json;
      const id = input?.id;
      if (mine[index] === "history") answers[index] = { result: { data: conversations[id][path] } };
      else if (mine[index] === "detail")
        answers[index] = {
          result: { data: patchDetail(answers[index].result.data, sessionPatches[id]) },
        };
      else if (mine[index] === "stop") {
        stops.push(input.turnId);
        // Stopped: the turn the fixture runs ends as Stop turn ends it.
        conversations[ids.stopping] = stoppedAfter(ids.stopping, me, at);
        answers[index] = { result: { data: { json: null } } };
      } else if (mine[index] === "send") {
        sent.push(input);
        if (sends === "refuse") {
          refused = true;
          answers[index] = {
            error: {
              json: {
                message: REFUSED,
                code: -32603,
                data: {
                  code: "CONFLICT",
                  httpStatus: 409,
                  path,
                  tag: "SessionNotSteerable",
                },
              },
            },
          };
        } else
          answers[index] = {
            result: {
              data: superjson(
                {
                  _tag: "Turn",
                  messageId: "fixture-message-1",
                  explanation: "Sent as your next turn.",
                  turn: {
                    id: "fixture-turn-9",
                    sessionId: id,
                    ordinal: 8,
                    status: "queued",
                    startedAt: null,
                    endedAt: null,
                  },
                },
                [],
              ),
            },
          };
      }
    });
    // The app batches every call: a batch answers with one entry per call.
    const batched = url.searchParams.has("batch");
    await route.fulfill({
      status: refused ? (paths.length > 1 ? 207 : 409) : (response?.status() ?? 200),
      contentType: "application/json",
      body: JSON.stringify(batched ? answers : answers[0]),
    });
  });
  const fixture = async (path, ready) => {
    await open("/no-such-page");
    await go(path);
    await ready();
  };

  // Write while it works (Doop V3_GaAmXQ5): your own turn runs, the composer offers Steer and
  // Stop turn, and the words being written stay in the field.
  await fixture(`/sessions/${ids.writing}`, async () => {
    await visible(page.getByRole("button", { name: "Stop turn" })).waitFor();
  });
  await field("Codex").fill(STEER);
  const steer = await visible(page.getByRole("button", { name: "Steer" })).isEnabled();
  note(`your own running turn: the composer shows Steer (enabled: ${steer}) and Stop turn`);
  await everywhere("fixture-writing-while-it-works");
  // The words are a draft of this session's: loading the page again keeps them. (The page is
  // loaded, then the session opened in it, so its reads come through this recipe's fixtures.)
  await fixture(`/sessions/${ids.writing}`, async () => {
    await field("Codex").waitFor();
  });
  const kept = await field("Codex").inputValue();
  if (kept !== STEER) throw new Error(`after a reload the field holds "${kept}"`);
  note("loading the page again keeps the words written in the session's composer");
  await field("Codex").fill("");

  // Sent into this turn (Doop ZUE5k5egRy): the message the server steered into the running turn,
  // dashed, with when the agent reads it.
  await fixture(`/sessions/${ids.steered}`, async () => {
    await visible(page.getByText(/^Sent into this turn\. Claude Code reads it/)).waitFor();
  });
  note(
    'a message sent into your own running turn reads "Sent into this turn. Claude Code reads it when its current step finishes."',
  );
  await everywhere("fixture-sent-into-the-turn");

  // Stop the turn (Doop CmwRoygsNP): Stop turn ends it, the turn reads Stopped after …, and the
  // session's tab reads Idle.
  await fixture(`/sessions/${ids.stopping}`, async () => {
    await visible(page.getByRole("button", { name: "Stop turn" })).waitFor();
  });
  await visible(page.getByRole("button", { name: "Stop turn" })).click();
  await visible(page.getByText(/^This turn was stopped at/)).waitFor({ timeout: 30_000 });
  await visible(page.getByText(/^Stopped after/)).waitFor();
  const tabWords = (await visible(page.getByRole("tab")).getAttribute("aria-label")) ?? "";
  if (!tabWords.includes("Idle")) throw new Error(`after Stop turn the tab reads "${tabWords}"`);
  note(
    `Stop turn interrupts turn ${JSON.stringify(stops)}; the turn reads Stopped after 1 min 14 s, the line says when it stopped and what is kept, and the tab reads "${tabWords}"`,
  );
  await field().waitFor();
  await everywhere("fixture-turn-stopped");

  // A message that couldn't send: it shows at once, says why with Try again and Edit, and stays
  // through a reload; Try again sends it again under the same key.
  await fixture(`/sessions/${ids.failing}`, async () => {
    await field().waitFor();
  });
  await field().fill(FAILING);
  await page.keyboard.press("Enter");
  await visible(page.getByText(REFUSED)).waitFor({ timeout: 30_000 });
  if ((await field().inputValue()) !== "")
    throw new Error("the field still holds the words after they were sent");
  const firstKey = sent.at(-1)?.clientMessageId;
  note(
    `a refused send: the message shows at once, the field empties, and the refusal reads "${REFUSED}" with Try again and Edit`,
  );
  await everywhere("fixture-send-failed");
  await fixture(`/sessions/${ids.failing}`, async () => {
    await visible(page.getByText(REFUSED)).waitFor();
  });
  await visible(page.getByText(FAILING, { exact: true })).waitFor();
  note("after a reload the message that couldn't send is still there, saying so, with Try again");
  sends = "take";
  const before = sent.length;
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await visible(page.getByText(REFUSED)).waitFor({ state: "hidden", timeout: 30_000 });
  for (let waited = 0; sent.length === before && waited < 100; waited += 1)
    await page.waitForTimeout(100);
  await settled();
  const retryKey = sent.at(-1)?.clientMessageId;
  note(
    `Try again sent it again (send ${sent.length}, ${firstKey === retryKey ? "the same key" : "a new key"}); the refusal and its buttons are gone`,
  );
  await capture("fixture-send-retried-desktop-light");

  // The model, thinking and permission of the next turn, in the session composer's menu.
  await visible(page.getByRole("button", { name: /^Model for the next turn: / })).click();
  await page.getByRole("menuitemcheckbox", { name: "Ask before acting" }).waitFor();
  await capture("fixture-next-turn-menu-desktop-light");
  await page.getByRole("menuitemcheckbox", { name: "Ask before acting" }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  sends = "take";
  await field().fill("Carry on.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => true);
  await settled();
  const withSelection = sent.at(-1)?.selection ?? null;
  if (withSelection?.permissionMode !== "ask")
    throw new Error(`the send carried selection ${JSON.stringify(withSelection)}`);
  note(
    `Ask before acting in the session's menu: the next message carries ${JSON.stringify(withSelection)}`,
  );

  // Where the viewer can't write to the agent: a session whose agent ended.
  await fixture(`/sessions/${ids.ended}`, async () => {
    await visible(page.getByText(/isn't running\. Resume the session to message it\.$/)).waitFor();
  });
  await settled();
  note("a session whose agent isn't running says so in the composer's place");
  await capture("composer-locked-desktop-light");

  // The home composer offers Ask before acting too, beside Thinking, Fast and landing.
  await page.unroute("**/trpc/**");
  await open("/");
  await visible(page.getByRole("button", { name: /^Agent and model: / })).click();
  const askHome = page.getByRole("menuitemcheckbox", { name: "Ask before acting" });
  await askHome.waitFor();
  await askHome.scrollIntoViewIfNeeded();
  await settled();
  await capture("home-agent-menu-desktop-light");
  await page.keyboard.press("Escape").catch(() => undefined);
  note("the New session composer's agent-and-model menu offers Ask before acting");
  await page.evaluate(() => sessionStorage.clear());
};

/** A conversation whose one turn, the viewer's own, runs now; `steers` went into it. */
const running = (sessionId, me, at, steers) => {
  const t1 = turn(
    sessionId,
    me,
    0,
    "running",
    "Add idempotency keys to refund requests, the same way checkout does it.",
    at(1.4),
    null,
    { steers },
  );
  return history({
    turns: [t1],
    items: [
      item(t1.id, "assistant-message", "completed", at(1.3), at(1.3), {
        text: "Reading how checkout does it first.",
      }),
      item(t1.id, "file-change", "completed", at(1.1), at(1.0), {
        title: "src/refunds/create-refund.ts",
      }),
      command(t1.id, "in-progress", at(0.5), at(0.5), "pnpm vitest run refunds"),
    ],
  });
};

/** The same turn after Stop turn: interrupted 1 min 14 s in. */
const stoppedAfter = (sessionId, me, at) => {
  const t1 = turn(
    sessionId,
    me,
    0,
    "interrupted",
    "Add idempotency keys to refund requests, the same way checkout does it.",
    at(1.4),
    new Date(new Date(at(1.4)).getTime() + 74_000).toISOString(),
  );
  return history({
    turns: [t1],
    items: [
      item(t1.id, "assistant-message", "completed", at(1.3), at(1.3), {
        text: "Reading how checkout does it first.",
      }),
      item(t1.id, "file-change", "completed", at(1.1), at(1.0), {
        title: "src/refunds/create-refund.ts",
      }),
      command(t1.id, "failed", at(0.5), at(0.2), "pnpm vitest run refunds"),
    ],
  });
};

/** A conversation whose one turn finished: the composer sends the next. */
const completed = (sessionId, me, at) => {
  const t1 = turn(
    sessionId,
    me,
    0,
    "completed",
    "Add idempotency keys to refund requests.",
    at(9),
    at(7),
  );
  return history({
    turns: [t1],
    items: [
      item(t1.id, "assistant-message", "completed", at(7.1), at(7.1), {
        text: "Refunds now carry an idempotency key built from the order and the refund's sequence number.",
      }),
    ],
  });
};
