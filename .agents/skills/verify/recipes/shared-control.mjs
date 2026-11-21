// Someone else's session, and shared control for the person who asked, in the web app (route
// PR 34, SLNT-1158; shared-control.md `ask`, `withdraw`, `grant`, `take-back`, `switch-ends-grants`,
// `viewer-lines`, `who-pays`, `sender-login`). Two people in the stack's one organization: its
// owner (the stack's first account) and a member who joins through an invitation. The session is
// the owner's `mend run` session the CLI batch beside this recipe starts:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/shared-control-setup.json
//   pnpm verify drive web --recipe shared-control --account <account.json>
//
// The driver captures one page, so the recipe's page switches between the two people by their
// sign-in cookies. Every ask, withdrawal, grant, dismissal and take-back is a real click against
// the stack, read back from the server. A local stack runs no agent
// (tooling/verify/local-stack-limits.json, `real-agent-turn`): the session's conversation, the
// member's send (refused for their Codex login, then taken) and their Codex login connecting
// again are fixture answers in the browser, so every capture is named `fixture-…`. The recipe sets
// verify-fixture to shared for the member, and puts it back to private, stops the session and
// leaves nobody holding or asking for shared control at its end.
import { history, item, patchDetail, superjson, turn } from "./session-fixtures.lib.mjs";

const SESSION_PREFIX = "share-";
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const MESSAGE =
  "Replaying a dead letter whose endpoint now returns 410 Gone will fail every time. Skip those on replay.";

/** One person's API, from the signed-in page: what the web app's data layer calls. */
const apiOf = (on) => (method, url, body) =>
  on.evaluate(
    async ({ verb, address, payload }) => {
      const response = await fetch(address, {
        method: verb,
        headers: { "content-type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await response.text();
      return { status: response.status, body: text === "" ? null : JSON.parse(text) };
    },
    { verb: method, address: url, payload: body },
  );
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};
/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note, typeSecret, registerSecret, account }) => {
  if (account === null) throw new Error("this recipe signs the owner in: run it with --account");
  const api = apiOf(page);
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  /** Light desktop, and with `all` the dark desktop and the light phone too. */
  const shoot = async (name, all = false) => {
    await page.mouse.move(2, 2);
    await settled();
    await capture(`${name}-desktop-light`);
    if (!all) return;
    await setTheme("dark");
    await capture(`${name}-desktop-dark`);
    await setTheme("light");
    await page.setViewportSize(PHONE);
    await settled();
    await capture(`${name}-phone-light`);
    await page.setViewportSize(DESKTOP);
    await settled();
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href],button")].some((node) =>
        Object.keys(node).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ href: to }), path);
  const band = (key) => page.locator(`[data-band="${key}"]`).filter({ visible: true }).first();

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/`);
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));
  const me = await api("GET", "/api/organization");
  expect("the owner's organization", me.status === 200, me);
  const ownerId = me.body.userId;

  // The owner's live `mend run` session from the CLI batch.
  const listed = await api("GET", "/api/sessions");
  const session = (listed.body ?? [])
    .filter(
      (row) =>
        row.ownerUserId === ownerId &&
        ["running", "idle"].includes(row.status) &&
        [row.label, row.worktree, row.branch].some((name) => (name ?? "").includes(SESSION_PREFIX)),
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  expect("the batch's session", session !== undefined, listed.status);
  const id = session.id;
  const base = `/api/sessions/${id}/shared-control`;
  note(`the owner's session ${id.slice(0, 8)} (${session.label ?? session.worktree})`);
  /** Load the app, then move to the session through the router, so its reads meet the fixtures. */
  const openSession = async () => {
    await page.goto(`${web}/no-such-page`);
    // Vite can reload a page while it compiles, before React takes it over: load it once more.
    await hydrated().catch(async () => {
      note("the page didn't hydrate; loading it again");
      await page.goto(`${web}/no-such-page`);
      await hydrated();
    });
    await go(`/sessions/${id}`);
    await visible(page.getByText(/^Webhook deliveries that fail 5 times are dropped\./)).waitFor();
  };

  // The member sees the project: verify-fixture shared, then a second person joins.
  const project = session.projectId;
  const shared = await api("PUT", `/api/projects/${project}/visibility`, { visibility: "shared" });
  expect("verify-fixture shared", shared.status === 200, shared);
  const invitation = await api("POST", "/api/organization/invitations", { role: "member" });
  expect("an invitation", invitation.status === 200, invitation.status);
  registerSecret("invitation-token", invitation.body.token);
  const second = await page.context().browser().newContext();
  const memberPage = await second.newPage();
  // A second browser's first load can be reloaded by Vite as it compiles: load again if so.
  const joinHeading = memberPage.getByRole("heading", { name: /^Join / });
  await memberPage.goto(`${web}/join#${invitation.body.token}`);
  try {
    await joinHeading.waitFor({ timeout: 45_000 });
  } catch {
    note(`the join page didn't show its heading (${memberPage.url()}); loading it again`);
    await memberPage.goto(`${web}/join#${invitation.body.token}`);
    await joinHeading.waitFor({ timeout: 60_000 }).catch(async (cause) => {
      const shown = (await memberPage.locator("body").innerText()).replace(/\s+/g, " ");
      note(`the join page shows: ${shown.slice(0, 300)}`);
      throw cause;
    });
  }
  const email = `verify-share-${Date.now()}@example.invalid`;
  await memberPage.getByRole("textbox", { name: "Name" }).fill("Ada Verify");
  await memberPage.getByRole("textbox", { name: "Email" }).fill(email);
  await typeSecret(
    memberPage.getByLabel("Password", { exact: true }),
    "member-password",
    "a-share-verify-password",
  );
  await typeSecret(
    memberPage.getByLabel("Confirm password"),
    "member-password",
    "a-share-verify-password",
  );
  await memberPage.getByRole("button", { name: "Create account and join", exact: true }).click();
  await memberPage.waitForURL((url) => url.pathname === "/welcome");
  const memberId = (await apiOf(memberPage)("GET", "/api/organization")).body.userId;
  const cookies = {
    owner: await page.context().cookies(),
    member: await second.cookies(),
  };
  await second.close();
  note(`a second person joined as a member, Ada Verify (${email})`);
  /** The page as one of the two people; the next load reads as them. */
  const as = async (who) => {
    await page.context().clearCookies();
    await page.context().addCookies(cookies[who]);
  };

  // ─── Fixtures: the conversation, the member's send, the member's Codex login ───
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const t1 = turn(
    id,
    ownerId,
    0,
    "completed",
    "Webhook deliveries that fail 5 times are dropped. Move them to a dead-letter table instead, and add a way to replay them.",
    at(40),
    at(37),
  );
  const firstItems = [
    item(t1.id, "assistant-message", "completed", at(37.1), at(37.1), {
      text: "When a delivery fails for the fifth time, it now goes into a new `webhook_dead_letters` table. `replayDeadLetter(id)` sends it again.",
    }),
  ];
  let conversation = history({ turns: [t1], items: firstItems });
  /** How the browser answers the member's send: refused for their Codex login, or taken. */
  let sends = "login";
  let connected = false;
  /** The waiting line's answer, once the recipe puts the member's turn behind background work. */
  let waiting = null;
  const sent = [];
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const mine = paths.map((path, index) => {
      const input = inputs[String(index)]?.json;
      if (path.startsWith("sessions.history") && input?.id === id) return "history";
      if (path === "sessions.detail" && input?.id === id) return "detail";
      if (path === "sessions.sendMessage" && input?.id === id) return "send";
      if (path === "platform.sealantIdentity" && connected) return "identity";
      if (path === "sessions.conversationWait" && input?.id === id) return "wait";
      return null;
    });
    if (mine.every((each) => each === null)) return route.continue();
    // The server answers every call in the batch the fixtures don't, and the ones they patch.
    const real = mine.some((each) => each === null || each === "detail" || each === "identity");
    const response = real ? await route.fetch() : null;
    const body = response === null ? null : await response.json();
    const answers = body === null ? paths.map(() => null) : Array.isArray(body) ? body : [body];
    let refused = false;
    paths.forEach((path, index) => {
      const input = inputs[String(index)]?.json;
      if (mine[index] === "history") answers[index] = { result: { data: conversation[path] } };
      else if (mine[index] === "wait")
        answers[index] = {
          result: { data: waiting === null ? { json: null } : superjson(waiting, ["since"]) },
        };
      else if (mine[index] === "detail") {
        const data = patchDetail(answers[index].result.data, {
          status: "running",
          harness: "codex",
          protocolAgent: true,
        });
        // Both people run as themselves in the workspace: what the waiting line needs.
        data.json.session.livePeople = [
          { accountId: ownerId, name: "Verifier" },
          { accountId: memberId, name: "Ada Verify" },
        ];
        answers[index] = { result: { data } };
      } else if (mine[index] === "identity") {
        const data = structuredClone(answers[index].result.data);
        const added = data.json.accounts.length;
        const stamp = new Date().toISOString();
        data.json.accounts.push({
          id: "fixture-codex",
          provider: "codex",
          name: "default",
          kind: "auth-json",
          status: "active",
          metadata: {},
          connectedAt: stamp,
          updatedAt: stamp,
          lastUsedAt: null,
          isDefault: true,
        });
        data.meta = {
          ...data.meta,
          values: {
            ...data.meta?.values,
            [`accounts.${added}.connectedAt`]: ["Date"],
            [`accounts.${added}.updatedAt`]: ["Date"],
          },
        };
        answers[index] = { result: { data } };
      } else if (mine[index] === "send") {
        sent.push({ ...input, answered: sends });
        if (sends === "login") {
          refused = true;
          answers[index] = {
            error: {
              json: {
                message:
                  "Your Codex login needs connecting again. Run mend connect codex, then send again.",
                code: -32603,
                data: {
                  code: "FORBIDDEN",
                  httpStatus: 403,
                  path,
                  tag: "SessionNotSteerable",
                  sharedControl: { reason: null, login: { provider: "codex", state: "invalid" } },
                },
              },
            },
          };
        } else {
          // Taken as the member's turn: the conversation now holds it, on their own login.
          const start = new Date().toISOString();
          const t2 = turn(id, memberId, 1, "completed", input.input, start, start, {
            clientMessageId: input.clientMessageId,
          });
          conversation = history({
            turns: [t1, t2],
            items: [
              ...firstItems,
              item(t2.id, "assistant-message", "completed", start, start, {
                text: "Replay now checks the endpoint first. A dead letter whose endpoint answers 410 Gone is marked abandoned and not sent again.",
              }),
            ],
          });
          answers[index] = {
            result: {
              data: superjson(
                {
                  _tag: "Turn",
                  messageId: "fixture-message-2",
                  explanation: "Sent as your next turn.",
                  turn: {
                    id: t2.id,
                    sessionId: id,
                    ordinal: 1,
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
      }
    });
    const batched = url.searchParams.has("batch");
    await route.fulfill({
      status: refused ? (paths.length > 1 ? 207 : 403) : (response?.status() ?? 200),
      contentType: "application/json",
      body: JSON.stringify(batched ? answers : answers[0]),
    });
  });

  const read = async () => (await api("GET", base)).body;

  try {
    // ─── Someone else's session: reading (Doop aOglz_o0-L) ───
    await as("member");
    await openSession();
    await band("watching").getByRole("button", { name: "Ask for shared control" }).waitFor();
    await visible(page.getByText(/^Only .+ can send messages in this session\.$/)).waitFor();
    note(
      `member: the band reads "${(await band("watching").innerText()).replace(/\s+/g, " ")}"; the composer says only the owner sends messages`,
    );
    await shoot("fixture-member-reading", true);

    // ─── Ask (Doop luopCOKJ9y) ───
    await band("watching").getByRole("button", { name: "Ask for shared control" }).click();
    await band("asked").getByRole("button", { name: "Cancel request" }).waitFor();
    await visible(page.getByText(/^You asked .+ for shared control ·/)).waitFor();
    const afterAsk = await read();
    expect(
      "the ask",
      afterAsk.asked.some((person) => person.userId === memberId),
      afterAsk,
    );
    note("member asks: the band reads You asked … for shared control at …, with Cancel request");
    await shoot("fixture-member-asked", true);

    // ─── The owner's inbox and session (Doop wn4nHUo6vU) ───
    await as("owner");
    await openSession();
    await visible(page.getByText(/Ada asked for shared control/)).waitFor();
    await band(`ask:${memberId}`).waitFor();
    await visible(page.getByText(/^Ada Verify asked for shared control ·/)).waitFor();
    note(
      'owner: the sidebar row sits under Waiting on you reading "Ada asked for shared control"; the session shows the ask with Turn on shared control… and Dismiss request, and the marker',
    );
    await shoot("fixture-owner-sees-the-ask", true);

    // ─── Turn on, through the dialog (Doop AHtn13Oeux) ───
    await band(`ask:${memberId}`).getByRole("button", { name: "Turn on shared control…" }).click();
    const dialog = page.getByRole("dialog", { name: "Turn on shared control for Ada Verify?" });
    await dialog.waitFor();
    await settled();
    await shoot("fixture-owner-turn-on-dialog");
    await page.setViewportSize(PHONE);
    await settled();
    await capture("fixture-owner-turn-on-dialog-phone-light");
    await page.setViewportSize(DESKTOP);
    await settled();
    await dialog.getByRole("button", { name: "Turn on shared control", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await band("shared").getByRole("button", { name: "Turn off shared control" }).waitFor();
    const afterGrant = await read();
    expect(
      "the grant",
      afterGrant.granted.map((person) => person.userId).join() === memberId &&
        afterGrant.everyoneSince === null,
      afterGrant,
    );
    note(
      "owner turns it on for Ada Verify: the band reads Shared control is on.; granted [member]",
    );
    await shoot("fixture-owner-shared-on", true);

    // ─── The member writes; their Codex login is refused (Doop qtdRbdX8kM, 0mOHi-PvVD) ───
    await as("member");
    await openSession();
    await band("steering").waitFor();
    const field = visible(page.getByRole("textbox", { name: "Message Codex" }));
    await field.waitFor();
    await field.fill(MESSAGE);
    await field.press("Enter");
    await visible(
      page.getByText(/^Your Codex login has expired, so your message wasn't sent\./),
    ).waitFor();
    const kept = await field.inputValue();
    expect("the words back in the box", kept === MESSAGE, kept);
    note(
      "member sends; the server refuses it for their Codex login: the band says so, and the words are back in the box",
    );
    await shoot("fixture-member-login-expired", true);
    await visible(page.getByRole("button", { name: "Connect again…" })).click();
    const connect = page.getByRole("dialog", { name: "Connect Codex again" });
    await connect.waitFor();
    await connect.getByText("mend connect codex").first().waitFor();
    await settled();
    await shoot("fixture-member-connect-again");
    // Codex connects on the member's computer: the `user` event reads their logins again.
    sends = "take";
    connected = true;
    await page.evaluate(() => {
      void window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["platform", "sealantIdentity"]],
      });
    });
    await visible(page.getByText(/^Replay now checks the endpoint first\./)).waitFor({
      timeout: 30_000,
    });
    await page.keyboard.press("Escape");
    await visible(page.getByText(/^Your Codex login has expired/)).waitFor({ state: "hidden" });
    expect(
      "the message sent again once connected",
      sent.length === 2 &&
        sent[1].answered === "take" &&
        sent[1].clientMessageId === sent[0].clientMessageId,
      sent,
    );
    note(
      "Codex connects: with no reload, Mend sends the held message again under the same key, the band goes and the turn shows",
    );
    await shoot("fixture-member-sent", true);

    // ─── The owner sees the member's message (Doop YaY17c-Vj_) ───
    await as("owner");
    await openSession();
    await visible(page.getByText(/Ada Verify · \d/)).waitFor();
    // Whose login the member's turn ran on: theirs where each person runs as themselves, else the
    // owner's own, which the owner's header leaves unnamed.
    const onSenders = (await api("GET", `/api/sessions/${id}`)).body?.control?.turnsOnSendersLogin;
    const header = onSenders === true ? "Codex · turn 2 · Ada Verify's login" : "Codex · turn 2";
    await visible(page.getByText(header, { exact: true })).waitFor();
    note(
      `owner: the member's message carries their initials and name; its turn reads "${header}" (turnsOnSendersLogin ${onSenders})`,
    );
    await shoot("fixture-owner-sees-the-message", true);

    // ─── The waiting line (per-person-homes.md `waiting-line`) ───
    // The owner's next turn waits for background work running as the member: the owner may end it.
    waiting = {
      sessionId: id,
      turnId: "fixture-turn-3",
      runsAs: memberId,
      sender: ownerId,
      openTurn: false,
      work: [
        { kind: "task", id: "fixture-task-1", description: "pnpm vitest --watch", endable: true },
        { kind: "wakeup", id: "fixture-wakeup-1", description: null, endable: false },
      ],
      line: "Waits for Ada Verify's 2 background tasks to finish before Verifier's turn starts.",
      since: new Date().toISOString(),
    };
    await openSession();
    const waits = visible(page.getByRole("status").filter({ hasText: /^Waits for / }));
    await waits.waitFor();
    const work = page.getByRole("list", { name: "Work the turn waits for" });
    await work.getByRole("button", { name: "End task pnpm vitest --watch" }).waitFor();
    expect("one End, for the work that can end", (await work.getByRole("button").count()) === 1, 0);
    note(
      "owner: the waiting line reads \"Waits for Ada Verify's 2 background tasks…\", with End for the task (the wakeup can't be ended)",
    );
    await shoot("fixture-owner-waiting-line");
    waiting = null;
    await openSession();

    // ─── Turn off from the tile's … (Doop BfsRBrpbsh) ───
    // The tile's "…" comes after the sidebar's own row menus in the page.
    await page
      .getByRole("button", { name: /^Actions for / })
      .filter({ visible: true })
      .last()
      .click();
    const off = page.getByRole("menuitem", { name: "Turn off shared control" });
    await off.waitFor();
    await settled();
    await capture("fixture-owner-turn-off-menu-desktop-light");
    await off.click();
    await band("shared").waitFor({ state: "hidden" });
    await visible(page.getByText(/^You turned off shared control for Ada Verify ·/)).waitFor();
    const afterOff = await read();
    expect("the take-back", afterOff.granted.length === 0, afterOff);
    note("owner turns it off from the tile's …: granted [], the marker says so");
    await shoot("fixture-owner-turned-off");

    // ─── Dismiss: the member asks again, the owner dismisses ───
    await as("member");
    await openSession();
    await band("watching").getByRole("button", { name: "Ask for shared control" }).click();
    await band("asked").waitFor();
    await as("owner");
    await openSession();
    await band(`ask:${memberId}`).getByRole("button", { name: "Dismiss request" }).click();
    await band(`ask:${memberId}`).waitFor({ state: "hidden" });
    await visible(
      page.getByText(/^You dismissed Ada Verify's request for shared control ·/),
    ).waitFor();
    const afterDismiss = await read();
    expect("the dismissal", afterDismiss.asked.length === 0, afterDismiss);
    note("member asks again; owner dismisses it: asked [], the marker says so");
    await as("member");
    await openSession();
    await band("watching").waitFor();
    await visible(page.getByText(/dismissed your request for shared control ·/)).waitFor();
    await shoot("fixture-member-dismissed");

    // ─── Cancel request (withdraw) ───
    await band("watching").getByRole("button", { name: "Ask for shared control" }).click();
    await band("asked").getByRole("button", { name: "Cancel request" }).click();
    await band("watching").waitFor();
    await visible(page.getByText(/^You cancelled your request for shared control ·/)).waitFor();
    note("member asks, then cancels: back to Ask for shared control, the marker says so");
    await shoot("fixture-member-cancelled");

    // ─── A grant of an ask withdrawn meanwhile is refused in words ───
    await band("watching").getByRole("button", { name: "Ask for shared control" }).click();
    await band("asked").waitFor();
    await as("owner");
    await openSession();
    await band(`ask:${memberId}`).getByRole("button", { name: "Turn on shared control…" }).click();
    const stale = page.getByRole("dialog", { name: "Turn on shared control for Ada Verify?" });
    await stale.waitFor();
    // The member cancels it while the owner reads the dialog.
    await as("member");
    const withdrawn = await api("POST", `${base}/withdraw`);
    expect("the member's withdrawal", withdrawn.status === 200, withdrawn.status);
    await as("owner");
    await stale.getByRole("button", { name: "Turn on shared control", exact: true }).click();
    await stale.getByText(/request is no longer open/).waitFor();
    note("owner grants an ask the member withdrew meanwhile: the dialog says it is no longer open");
    await shoot("fixture-owner-grant-refused");
    await stale.getByRole("button", { name: "Cancel" }).click();

    // ─── The old switch for everyone (`switch-ends-grants`) ───
    const on = await api("PUT", base, { enabled: true });
    expect("the switch for everyone on", on.status === 200, on.status);
    await openSession();
    await band("shared")
      .getByText(/Everyone who can see /)
      .waitFor();
    note(
      "the old switch on (PUT shared-control, as the CLI and older clients turn it): the band names everyone",
    );
    await shoot("fixture-owner-everyone-on");
    await as("member");
    await openSession();
    await visible(page.getByText(/turned on shared control for everyone who can see/)).waitFor();
    await shoot("fixture-member-everyone-on");
    await as("owner");
    await openSession();
    await band("shared").getByRole("button", { name: "Turn off shared control" }).click();
    await band("shared").waitFor({ state: "hidden" });
    const ended = await read();
    expect(
      "the switch off ends every grant",
      ended.everyoneSince === null && ended.granted.length === 0,
      ended,
    );
    note("owner turns it off from the band: everyoneSince null, granted []");
  } finally {
    await as("member");
    await page.goto(`${web}/no-such-page`);
    await api("POST", `${base}/withdraw`).catch(() => null);
    await as("owner");
    await page.goto(`${web}/no-such-page`);
    await api("PUT", base, { enabled: false });
    await api("POST", `/api/sessions/${id}/stop`);
    await api("PUT", `/api/projects/${project}/visibility`, { visibility: "private" });
    note("restored: shared control off, session stopped, verify-fixture private again");
  }
};
