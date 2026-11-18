// Answering the agent's questions and approvals in the new web app (route PR 14, SLNT-1138): the
// question card in the composer (a choice, a note, your own words, a question with two parts), an
// approval of a command, a file edit and a tool, Executor's tool approvals, an answer that couldn't
// send, one answered on another device or by someone else, and what someone who may not answer
// sees. Run the session recipe's CLI batch first, once per stack: it starts the real sessions this
// lays its fixtures over.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-session-sessions.json
//   pnpm verify drive new-web --recipe new-web-answer
//
// A local stack runs no agent (tooling/verify/local-stack-limits.json, `real-agent-turn`), so the
// requests are fixture answers to the sessions' reads, and the answers are taken in the browser;
// every capture taken that way is named `fixture-…`. new-web-answer-box asks a real agent on the
// box. The fixture sessions are Codex's where words are typed: the driver withholds a picture of a
// filled field whose name says "Code", as "Message Claude Code" does.
import {
  history,
  item,
  patchDetail,
  request,
  superjson,
  turn,
} from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const GRACE = "fixture-grace";
const NOTE = "Cap the total wait at 2 seconds so checkout never hangs.";
const OWN = "Back off on a 409, but only for charges. Refunds should treat a 409 as final for now.";
const INSTEAD = "Run terraform plan first and show me the change.";

const RETRY = {
  id: "q-retry",
  header: "Stripe sends a 409 when a request with the same key is still being processed.",
  question: "Should the retry back off on a 409?",
  options: [
    {
      label: "Treat 409 as final",
      description: "Return the error to the caller without retrying.",
    },
    { label: "Back off and retry", description: "Retry 3 times with backoff before failing." },
  ],
  multiSelect: false,
};
const WAIT = {
  id: "q-wait",
  header: "The waits add up across retries. After this long, the refund is marked as failed.",
  question: "How long should a refund wait in total?",
  options: [
    { label: "2 seconds", description: "Waits 250ms, 500ms and 1s, then gives up." },
    { label: "10 seconds", description: "Waits 1s, 3s and 6s, then gives up." },
  ],
  multiSelect: false,
};

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
  const field = (agent = "Codex") =>
    visible(page.getByRole("textbox", { name: `Message ${agent}` }));
  const choice = (label) => visible(page.getByRole("radio", { name: new RegExp(`^${label}`) }));
  // Reads the conversation again, as an event from the server would; not awaited, so the recipe's
  // own answers to /trpc aren't held up behind it.
  const reread = () =>
    page.evaluate(() => {
      void window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["sessions", "historyItems"]],
      });
    });

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
    question: idOf("session-running"),
    approval: idOf("session-turn"),
    viewer: idOf("session-credit"),
    executor: idOf("session-record"),
  };
  const live = { status: "running", harness: "codex", protocolAgent: true };
  const sessionPatches = {
    [ids.question]: live,
    [ids.approval]: live,
    [ids.viewer]: { ...live, viewerSteers: false, ownerUserId: GRACE },
    [ids.executor]: { ...live, harness: "claude" },
  };
  /** Each session's conversation as the fixture has it now; a scenario sets its own. */
  const conversations = {};
  /** How the browser answers an answer: taken, or not reached. */
  let answers = "take";
  const answered = [];
  const sent = [];
  /** The Executor call that waits, and what approving it records. */
  let executorCall = heldCall(ids.executor, me, at);
  const approvedCalls = [];

  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const mine = paths.map((path, index) => {
      const input = inputs[String(index)]?.json;
      const id = input?.id ?? input?.sessionId;
      if (path.startsWith("sessions.history") && conversations[id] !== undefined) return "history";
      if (path === "sessions.detail" && sessionPatches[id] !== undefined) return "detail";
      if (path === "sessions.respondRequest") return "respond";
      if (path === "sessions.sendMessage") return "send";
      if (path === "organization.members") return "members";
      if (path.startsWith("executor.") && id === ids.executor) return path;
      return null;
    });
    if (mine.every((each) => each === null)) return route.continue();
    const real = mine.some((each) => each === "detail" || each === "members");
    const response = real ? await route.fetch() : null;
    const body = response === null ? null : await response.json();
    const out = body === null ? paths.map(() => null) : Array.isArray(body) ? body : [body];
    let failed = false;
    paths.forEach((path, index) => {
      const input = inputs[String(index)]?.json;
      const id = input?.id ?? input?.sessionId;
      switch (mine[index]) {
        case "history":
          out[index] = { result: { data: conversations[id][path] } };
          break;
        case "detail":
          out[index] = {
            result: { data: patchDetail(out[index].result.data, sessionPatches[id]) },
          };
          break;
        case "members": {
          const members = out[index].result.data.json;
          const grace = {
            ...members[0],
            userId: GRACE,
            name: "Grace Hopper",
            email: "grace@example.com",
          };
          out[index] = {
            result: { data: { ...out[index].result.data, json: [...members, grace] } },
          };
          break;
        }
        case "respond": {
          answered.push(input);
          if (answers === "fail") {
            failed = true;
            out[index] = {
              error: {
                json: {
                  message: "Mend couldn't reach the server.",
                  code: -32603,
                  data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 503, path },
                },
              },
            };
            break;
          }
          const settledRequest = settle(conversations, input, me, at(0));
          out[index] = {
            result: { data: superjson(settledRequest, ["createdAt", "decidedAt"]) },
          };
          break;
        }
        case "send":
          sent.push(input);
          out[index] = {
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
          break;
        case "executor.calls":
          out[index] = {
            result: {
              data: superjson({ calls: [executorCall], olderCursor: null }, [
                "calls.0.createdAt",
                "calls.0.observedAt",
                ...(executorCall.expiresAt === null ? [] : ["calls.0.expiresAt"]),
              ]),
            },
          };
          break;
        case "executor.approval":
          out[index] = {
            result: {
              data: superjson(
                {
                  call: executorCall,
                  message: "Claude Code wants to file a Linear issue as you.",
                  inputSchema: {},
                  arguments: {
                    team: "NW",
                    title: "Back off on a 409 from Stripe when refunding",
                    labels: ["payments", "follow-up"],
                  },
                },
                ["call.createdAt", "call.observedAt", "call.expiresAt"],
              ),
            },
          };
          break;
        case "executor.approve":
          approvedCalls.push(input);
          executorCall = { ...executorCall, outcome: "completed", message: "Filed NW-412." };
          out[index] = {
            result: {
              data: superjson(executorCall, ["createdAt", "observedAt", "expiresAt"]),
            },
          };
          break;
        default:
          break;
      }
    });
    // The app batches every call: a batch answers with one entry per call.
    const batched = url.searchParams.has("batch");
    await route.fulfill({
      status: failed ? (paths.length > 1 ? 207 : 503) : (response?.status() ?? 200),
      contentType: "application/json",
      body: JSON.stringify(batched ? out : out[0]),
    });
  });
  const fixture = async (path, ready) => {
    await open("/no-such-page");
    // The server render read the members; read them again here, where the fixture adds Grace.
    await page.evaluate(() => {
      void window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["organization", "members"]],
      });
    });
    await go(path);
    await ready();
  };
  const question = `/sessions/${ids.question}`;

  // Question · nothing picked (Doop cCS2-C0Dad): the choices in the composer card, the marker in
  // the conversation, and send off until there is an answer.
  conversations[ids.question] = asking(ids.question, me, at, [RETRY]);
  await fixture(question, () => visible(page.getByText(RETRY.question)).waitFor());
  await visible(page.getByText("Asked you a question · Waiting for your answer")).waitFor();
  const sendOff = await visible(page.getByRole("button", { name: "Send" })).isDisabled();
  note(
    `wait-question: the question shows in the composer card; send is off (${sendOff}) until a choice or words`,
  );
  await everywhere("fixture-question-nothing-picked");

  // A choice picked (Xv1xTy1X2U), then a note typed beside it (ArbnayDHst).
  await choice("Back off and retry").click();
  await visible(page.getByText("Press Enter to send your answer, or add a note below.")).waitFor();
  await visible(page.getByPlaceholder("Add a note (optional)")).waitFor();
  await everywhere("fixture-question-picked");
  await field().fill(NOTE);
  await visible(page.getByText("Press Enter to send your answer with the note.")).waitFor();
  await everywhere("fixture-question-picked-note");

  // Couldn't send (vmqisLRU5T): the answer stays, the band says why, with Try again.
  answers = "fail";
  await page.keyboard.press("Enter");
  await visible(page.getByText(/^Your answer wasn't sent\./)).waitFor({ timeout: 30_000 });
  const keptNote = await field().inputValue();
  note(
    `an answer that couldn't send: the band says so with Try again; the note is kept ("${keptNote === NOTE ? "the same words" : keptNote}")`,
  );
  await everywhere("fixture-question-couldnt-send");

  // Try again sends it; the card goes, and the line in the conversation says what you chose, with
  // the note as your message (BNfFVQFlWC).
  answers = "take";
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await visible(page.getByText("You chose Back off and retry")).waitFor({ timeout: 30_000 });
  await visible(page.getByText(NOTE, { exact: true })).waitFor();
  const sentAnswer = answered.at(-1)?.response;
  if (
    JSON.stringify(sentAnswer) !==
    JSON.stringify({ answers: { [RETRY.id]: ["Back off and retry", NOTE] } })
  )
    throw new Error(`the answer sent was ${JSON.stringify(sentAnswer)}`);
  note(
    `wait-clears: Try again sent ${JSON.stringify(sentAnswer)}; the card left the composer and the conversation reads "You chose Back off and retry" with the note`,
  );
  await everywhere("fixture-question-sent");

  // Writing your own answer (Xj8HkUAnTF): Something else, then the words are the answer
  // (Nw3InoacWy).
  conversations[ids.question] = asking(ids.question, me, at, [RETRY]);
  await fixture(question, () => visible(page.getByText(RETRY.question)).waitFor());
  await choice("Something else").click();
  await visible(page.getByText("Write your answer below, then press Enter.")).waitFor();
  await field().fill(OWN);
  await everywhere("fixture-question-own-words");
  await page.keyboard.press("Enter");
  await visible(page.getByText("You answered in your own words")).waitFor({ timeout: 30_000 });
  note(`your own answer sent: ${JSON.stringify(answered.at(-1)?.response)}`);
  await everywhere("fixture-question-own-words-sent");

  // A question with two parts (8eDp9X58f8, QpV5v_H39L): the first answered goes on to the second,
  // folded above it with Change; the last send sends both.
  conversations[ids.question] = asking(ids.question, me, at, [RETRY, WAIT]);
  await fixture(question, () => visible(page.getByText(RETRY.question)).waitFor());
  await visible(page.getByText("1 of 2", { exact: true })).waitFor();
  await everywhere("fixture-question-two-parts-1");
  await choice("Back off and retry").click();
  await field().press("Enter");
  await visible(page.getByText(WAIT.question)).waitFor();
  await visible(
    page.getByRole("button", { name: "Change your answer to Question 1: Back off and retry" }),
  ).waitFor();
  await choice("2 seconds").click();
  await everywhere("fixture-question-two-parts-2");
  await field().press("Enter");
  await visible(page.getByText("You answered 2 questions")).waitFor({ timeout: 30_000 });
  note(
    `a question with two parts: both sent together, ${JSON.stringify(answered.at(-1)?.response)}`,
  );

  // Answered on another device (JC-flm9elW): the card this tab showed is answered by you elsewhere.
  conversations[ids.question] = asking(ids.question, me, at, [RETRY]);
  await fixture(question, () => visible(page.getByText(RETRY.question)).waitFor());
  conversations[ids.question] = asking(ids.question, me, at, [RETRY], {
    status: "resolved",
    answers: { [RETRY.id]: ["Back off and retry"] },
    decidedBy: me,
    decidedAt: at(0.1),
  });
  await reread();
  await visible(page.getByText("You answered on another device.")).waitFor({ timeout: 30_000 });
  note(
    "answered on another device: the card goes and the band says you answered elsewhere, with Dismiss",
  );
  await everywhere("fixture-question-answered-elsewhere");
  await visible(page.getByRole("button", { name: "Dismiss" })).click();

  // Answered by Grace Hopper (Ymh5GjsugP): someone with shared control answered first, while the
  // words written here stay unsent.
  conversations[ids.question] = asking(ids.question, me, at, [RETRY]);
  await fixture(question, () => visible(page.getByText(RETRY.question)).waitFor());
  await choice("Something else").click();
  await field().fill(OWN);
  conversations[ids.question] = asking(ids.question, me, at, [RETRY], {
    status: "resolved",
    answers: { [RETRY.id]: ["Treat 409 as final"] },
    decidedBy: GRACE,
    decidedAt: at(0.1),
  });
  await reread();
  await visible(page.getByText("Grace Hopper answered first.")).waitFor({ timeout: 30_000 });
  await visible(page.getByText("Grace Hopper chose Treat 409 as final")).waitFor();
  const unsent = await field().inputValue();
  note(
    `answered by someone else: the band names Grace Hopper; the words written stay unsent (${unsent === OWN})`,
  );
  await everywhere("fixture-question-answered-by-someone");
  await field().fill("");

  // Approve a command (jBZKLzNEqz): the command and where it runs; Approve once.
  const approval = `/sessions/${ids.approval}`;
  conversations[ids.approval] = approving(ids.approval, me, at, "command");
  await fixture(approval, () => visible(page.getByText("Codex wants to run a command")).waitFor());
  await visible(page.getByText("Wants to run a command · Waiting for your approval")).waitFor();
  note(
    "wait-permission: the command shows in the composer card with Approve once, Always allow, Deny and Approve",
  );
  await everywhere("fixture-approve-command");
  await visible(page.getByRole("button", { name: "Approve", exact: true })).click();
  await visible(page.getByText("You approved the command once")).waitFor({ timeout: 30_000 });
  note(`approved: ${JSON.stringify(answered.at(-1)?.response)}`);
  await everywhere("fixture-approve-command-approved");

  // Denied, telling it what to do instead: the words deny it and go to the agent as a message.
  conversations[ids.approval] = approving(ids.approval, me, at, "command");
  await fixture(approval, () => visible(page.getByText("Codex wants to run a command")).waitFor());
  await field().fill(INSTEAD);
  await everywhere("fixture-approve-command-instead");
  await page.keyboard.press("Enter");
  await visible(page.getByText("You denied")).waitFor({ timeout: 30_000 });
  for (let waited = 0; sent.length === 0 && waited < 100; waited += 1)
    await page.waitForTimeout(100);
  note(
    `words instead: denied (${JSON.stringify(answered.at(-1)?.response)}) and sent "${sent.at(-1)?.input}" to Codex`,
  );
  await everywhere("fixture-approve-command-denied");

  // Approve a file edit (lAu7FLpuVv): the diff from the turn's file-change item; Deny.
  conversations[ids.approval] = approving(ids.approval, me, at, "edit");
  await fixture(approval, () => visible(page.getByText("Codex wants to edit a file")).waitFor());
  await everywhere("fixture-approve-edit");
  await visible(page.getByRole("button", { name: "Deny", exact: true })).click();
  await visible(page.getByText(/^You denied/)).waitFor({ timeout: 30_000 });
  note(`an edit denied: ${JSON.stringify(answered.at(-1)?.response)}`);

  // Approve a tool (is4GoBws9p): an MCP server's tool and its arguments; Always allow.
  conversations[ids.approval] = approving(ids.approval, me, at, "tool");
  await fixture(approval, () => visible(page.getByText("Codex wants to use a tool")).waitFor());
  await everywhere("fixture-approve-tool");
  await visible(page.getByRole("radio", { name: /^Always allow/ })).click();
  await visible(page.getByRole("button", { name: "Approve", exact: true })).click();
  await visible(page.getByText("You allowed the tool for this session")).waitFor({
    timeout: 30_000,
  });
  note(`a tool allowed for the session: ${JSON.stringify(answered.at(-1)?.response)}`);

  // Already approved on another device (jcan05_hWB).
  conversations[ids.approval] = approving(ids.approval, me, at, "command");
  await fixture(approval, () => visible(page.getByText("Codex wants to run a command")).waitFor());
  conversations[ids.approval] = approving(ids.approval, me, at, "command", {
    status: "resolved",
    decision: "accept",
    decidedBy: me,
    decidedAt: at(0.1),
  });
  await reread();
  await visible(page.getByText("Already answered on another device.")).waitFor({ timeout: 30_000 });
  await everywhere("fixture-approve-answered-elsewhere");

  // Someone who may not answer (shared-control: anyone who steers answers; nobody else): what was
  // asked, whose answer it waits for, and no controls.
  conversations[ids.viewer] = asking(ids.viewer, GRACE, at, [RETRY]);
  await fixture(`/sessions/${ids.viewer}`, () => visible(page.getByText(RETRY.question)).waitFor());
  await visible(page.getByText(/Waiting for Grace Hopper's answer$/)).waitFor();
  const radios = await page.getByRole("radio").count();
  note(
    `someone who may not answer: the question shows with ${radios} controls, the marker waits for Grace Hopper, and the composer says only she or someone she shares control with answers`,
  );
  await everywhere("fixture-question-not-yours");

  // Executor's tool approval: the call waits on you, in the same card; Approve.
  conversations[ids.executor] = quiet(ids.executor, me, at);
  await fixture(`/sessions/${ids.executor}`, () =>
    visible(page.getByText("Claude Code wants to use a tool")).waitFor(),
  );
  await visible(page.getByText("linear · create_issue")).waitFor();
  await everywhere("fixture-executor-approval");
  await visible(page.getByRole("button", { name: "Approve", exact: true })).click();
  for (let waited = 0; approvedCalls.length === 0 && waited < 100; waited += 1)
    await page.waitForTimeout(100);
  await visible(page.getByText("Claude Code wants to use a tool")).waitFor({
    state: "hidden",
    timeout: 30_000,
  });
  note(`an Executor call approved: ${JSON.stringify(approvedCalls.at(-1))}; the card goes`);

  await page.unroute("**/trpc/**");
  await page.evaluate(() => sessionStorage.clear());
};

/** The running turn the agent asks in, with what it did before asking. */
const askingTurn = (sessionId, me, at) =>
  turn(sessionId, me, 0, "running", "Find out why checkout charges twice and fix it.", at(4), null);

/** A conversation whose agent asks `questions` and waits; `settle` answers it. */
const asking = (sessionId, me, at, questions, settle = {}) => {
  const t1 = askingTurn(sessionId, me, at);
  return history({
    turns: [t1],
    items: [
      item(t1.id, "assistant-message", "completed", at(3), at(3), {
        text: "After a 503, the retry wrapper sent the charge again without an idempotency key. I added a key based on the order id; before I add a retry I need a decision from you.",
      }),
    ],
    requests: [
      request("fixture-request-question", t1.id, "user-input", at(2), { questions, ...settle }),
    ],
  });
};

/** A conversation whose agent waits on an approval of `kind`: a command, an edit or a tool. */
const approving = (sessionId, me, at, kind, settle = {}) => {
  const t1 = turn(
    sessionId,
    me,
    0,
    "running",
    "Rotate the staging database password.",
    at(4),
    null,
  );
  const edit = item(t1.id, "file-change", "in-progress", at(2.1), at(2.1), {
    title: "migrations/0043_drop_coupon.sql",
    data: {
      changes: [
        {
          path: "migrations/0043_drop_coupon.sql",
          diff: "@@ -1,3 +1,5 @@\n BEGIN;\n-ALTER TABLE legacy_coupons RENAME TO legacy_coupons_old;\n+-- Coupons live in billing.discounts since 0039.\n+DROP INDEX IF EXISTS legacy_coupons_code_idx;\n+DROP TABLE IF EXISTS legacy_coupons;\n COMMIT;",
        },
      ],
    },
  });
  const asks = {
    command: {
      kind: "command-approval",
      title: "terraform apply -target=module.staging_db",
      detail: { command: "terraform apply -target=module.staging_db", cwd: "infra/", reason: null },
    },
    edit: { kind: "file-change-approval", title: null, detail: { itemId: "x", reason: null } },
    tool: {
      kind: "tool-permission",
      title: "mcp__linear__create_issue",
      detail: {
        toolName: "mcp__linear__create_issue",
        team: "NW",
        title: "Back off on a 409 from Stripe when refunding",
        labels: ["payments", "follow-up"],
        suggestions: [],
      },
    },
  }[kind];
  return history({
    turns: [t1],
    items: [
      item(t1.id, "assistant-message", "completed", at(3), at(3), {
        text: "The change is ready, and I need your approval for the next step.",
      }),
      ...(kind === "edit" ? [edit] : []),
    ],
    requests: [
      request("fixture-request-approval", t1.id, asks.kind, at(2), {
        title: asks.title,
        detail: asks.detail,
        ...settle,
      }),
    ],
  });
};

/** A conversation with nothing asked: the Executor call waits beside it. */
const quiet = (sessionId, me, at) => {
  const t1 = turn(
    sessionId,
    me,
    0,
    "running",
    "File a Linear issue for the refund follow-up.",
    at(3),
    null,
  );
  return history({
    turns: [t1],
    items: [
      item(t1.id, "assistant-message", "completed", at(2), at(2), {
        text: "I'll file it in the Northwind team through Executor.",
      }),
    ],
  });
};

/** An Executor call the viewer must approve. */
const heldCall = (sessionId, me, at) => ({
  id: "fixture-call-1",
  sessionId,
  service: "linear",
  tool: "create_issue",
  asUserId: me,
  asMember: false,
  approverId: me,
  outcome: "held",
  message: "Waiting for approval in Mend.",
  observations: [],
  createdAt: at(1),
  observedAt: at(1),
  expiresAt: at(-10),
});

/**
 * The request an answer settles, as the server answers it, and the fixture conversation that holds
 * it read again with it settled, as the next read would find it.
 */
const settle = (conversations, input, me, decidedAt) => {
  for (const [sessionId, conversation] of Object.entries(conversations)) {
    const held = conversation["sessions.historyRequests"].json.requests;
    const at = held.findIndex((each) => each.id === input.requestId);
    if (at < 0) continue;
    const settledRequest = {
      ...held[at],
      status: "resolved",
      decidedBy: me,
      decidedAt,
      ...("decision" in input.response
        ? { decision: input.response.decision }
        : { answers: input.response.answers }),
    };
    const requests = held.map((each, index) => (index === at ? settledRequest : each));
    conversations[sessionId] = history({
      turns: conversation["sessions.historyTurns"].json.turns,
      items: conversation["sessions.historyItems"].json.items,
      requests,
    });
    return settledRequest;
  }
  throw new Error(`an answer to ${input.requestId}, which no fixture asked`);
};
