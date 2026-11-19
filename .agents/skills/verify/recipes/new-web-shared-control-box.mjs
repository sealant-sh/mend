// Shared control for the person who asked, on the box, with a real Codex session (route PR 34,
// SLNT-1158). The box has two people: its checker account (`boat-check@example.test`, owner of
// Default, with a Codex login) and the main run's second account (`main-run-second@example.test`,
// a member with no agent login; box-main-run's fixtures). A drive signs in one account, so this
// recipe is driven five times, alternating, and each run reads the server to know its step:
//
//   pnpm verify drive new-web --box --recipe new-web-shared-control-box            # 1 checker: start
//   MEND_VERIFY_BOX_EMAIL=main-run-second@example.test \
//   MEND_VERIFY_BOX_PASSWORD_FILE=~/.local/share/mend-boat-check-2/password \
//     pnpm verify drive new-web --box --recipe new-web-shared-control-box          # 2 second: ask
//   pnpm verify drive new-web --box --recipe new-web-shared-control-box            # 3 checker: grant
//   (second again)                                                                  # 4 second: send
//   pnpm verify drive new-web --box --recipe new-web-shared-control-box            # 5 checker: off
//
// 1. The checker starts a Codex session in verify-fixture from the New session composer, waits
//    for its reply, and shares verify-fixture with the organization.
// 2. The second account opens it: whose session it is, Ask for shared control; asks.
// 3. The checker sees the ask under Waiting on you and on the session, and turns it on through
//    the dialog.
// 4. The second account, now able to send, sends a message: the box refuses it for their own
//    Codex login (they have none), the band says so and the words stay in the box.
// 5. The checker sends a message of their own, then turns shared control off from the tile's "…",
//    stops the session and puts verify-fixture back to private.
//
// A turn sent by the second account can't run here: they have no Codex login, and the box's
// fixtures keep it that way. That state is driven locally (new-web-shared-control).
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
const CHECKER = "boat-check@example.test";
/** Step 1 names its session so the later steps find it among the box's other sessions. */
const LABEL = "Shared control check";
const FIRST = "Reply with the single word hello and change nothing.";
const SECOND = "Reply with the single word pong and change nothing.";
const THIRD = "Reply with the single word again and change nothing.";

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};

export default async ({ page, web, capture, note, account }) => {
  const api = (method, url, body) =>
    page.evaluate(
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
  const settled = () => page.waitForTimeout(500);
  const both = async (name) => {
    await page.mouse.move(2, 2);
    await settled();
    await capture(`${name}-desktop-light`);
    await page.setViewportSize(PHONE);
    await settled();
    await capture(`${name}-phone-light`);
    await page.setViewportSize(DESKTOP);
    await settled();
  };
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some((button) =>
        Object.keys(button).some((key) => key.startsWith("__reactProps")),
      ),
    );
  /** The Details view's line for this session: who holds shared control, and its steps. */
  const details = async (id, name) => {
    await page.goto(`${web}/sessions/${id}/details`);
    await hydrated();
    const sessions = page
      .getByRole("region", { name: "Sessions in this workspace", exact: true })
      .filter({ visible: true })
      .first();
    await sessions.waitFor({ timeout: 60_000 });
    const words = (await sessions.innerText()).replace(/\s+/g, " ").trim();
    note(`${name}: the Details view's sessions read "${words}"`);
    await capture(`${name}-desktop-light`);
    return sessions;
  };
  const band = (key) => page.locator(`[data-band="${key}"]`).filter({ visible: true }).first();
  const field = () => visible(page.getByRole("textbox", { name: "Message Codex" }));
  /** Write in the composer once it holds the words: it keeps them per account, once that is read. */
  const write = async (words) => {
    for (let tries = 0; tries < 20; tries += 1) {
      await field().fill(words);
      if ((await field().inputValue()) === words) return;
      await page.waitForTimeout(500);
    }
    throw new Error("the composer never kept the words");
  };
  const reply = (word) =>
    visible(page.getByText(new RegExp(`^${word}\\.?$`, "i"))).waitFor({ timeout: TURN_MS });

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/`);
  await hydrated();
  const me = (await api("GET", "/api/organization")).body;
  const checker = account?.email === CHECKER;
  note(
    `signed in as ${account?.email} (${checker ? "the checker, the owner" : "the second account"})`,
  );

  // The session step 1 started and named, newest first; a stopped one too (sending resumes it).
  const projects = (await api("GET", "/api/projects")).body ?? [];
  const fixture = projects.find((project) => project.name === "verify-fixture");
  const sessions = (await api("GET", "/api/sessions")).body ?? [];
  const ours = sessions
    .filter(
      (row) =>
        row.label === LABEL &&
        row.harness === "codex" &&
        (fixture === undefined || row.projectId === fixture.id) &&
        // Stopped too: a step 5 that failed after its stop runs again, and sending resumes it.
        !["completed", "failed"].includes(row.status) &&
        Date.now() - new Date(row.createdAt).getTime() < 3 * 3_600_000,
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const open = async (id) => {
    await page.goto(`${web}/sessions/${id}`);
    await hydrated();
    await visible(page.getByText(FIRST)).waitFor({ timeout: 60_000 });
  };

  if (checker && ours === undefined) {
    // ─── 1. The checker starts the session ───
    const pick = (name) => visible(page.getByRole("button", { name }));
    await pick(/^Project: /).click();
    await page.getByPlaceholder("Find a project").fill("verify-fixture");
    await page
      .getByRole("option", { name: /^verify-fixture/ })
      .first()
      .click();
    await pick(/^Agent and model: /).click();
    await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
    await page.keyboard.press("Escape").catch(() => undefined);
    await visible(page.getByRole("textbox", { name: "Task" })).fill(FIRST);
    await visible(page.getByRole("button", { name: "Start session" })).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
    const id = new URL(page.url()).pathname.split("/").at(-1);
    const named = await api("POST", `/api/sessions/${id}/label`, { label: LABEL });
    expect("the session named", named.status === 200, named);
    await reply("hello");
    const shared = await api("PUT", `/api/projects/${fixture.id}/visibility`, {
      visibility: "shared",
    });
    expect("verify-fixture shared", shared.status === 200, shared);
    note(`step 1: started Codex session ${id}, it replied hello; verify-fixture shared`);
    await both("box-owner-own-session");
    return;
  }
  expect("the session step 1 started", ours !== undefined, sessions.length);
  const id = ours.id;
  const base = `/api/sessions/${id}/shared-control`;
  const view = (await api("GET", base)).body;
  note(
    `session ${id}: granted ${JSON.stringify(view.granted.map((p) => p.userId))}, asked ${JSON.stringify(view.asked.map((p) => p.userId))}`,
  );

  if (!checker && view.granted.length === 0) {
    // ─── 2. The second account reads it and asks ───
    await open(id);
    await band("watching").getByRole("button", { name: "Ask for shared control" }).waitFor();
    await visible(page.getByText(/^Only .+ can send messages in this session\.$/)).waitFor();
    note(
      `step 2: the band reads "${(await band("watching").innerText()).replace(/\s+/g, " ")}", and the composer says only the owner sends messages`,
    );
    await both("box-second-reading");
    await band("watching").getByRole("button", { name: "Ask for shared control" }).click();
    await band("asked").getByRole("button", { name: "Cancel request" }).waitFor();
    await visible(page.getByText(/^You asked .+ for shared control ·/)).waitFor();
    note("step 2: asked; the band says when, with Cancel request, and the conversation marks it");
    await both("box-second-asked");
    return;
  }

  if (checker && view.asked.length > 0) {
    // ─── 3. The checker sees the ask and turns it on ───
    const asker = view.asked[0].userId;
    await open(id);
    const waiting = page
      .getByRole("navigation", { name: "Inbox" })
      .getByRole("region", { name: "Waiting on you", exact: true })
      .locator(`a[href="/sessions/${id}"]`);
    await waiting.first().waitFor();
    note(
      `step 3: the session's row is under Waiting on you, reading "${(await waiting.first().innerText()).replace(/\s+/g, " ")}"`,
    );
    await band(`ask:${asker}`).waitFor();
    await both("box-owner-sees-the-ask");
    await band(`ask:${asker}`).getByRole("button", { name: "Turn on shared control…" }).click();
    const dialog = page.getByRole("dialog", { name: /^Turn on shared control for / });
    await dialog.waitFor();
    await settled();
    await capture("box-owner-turn-on-dialog-desktop-light");
    await dialog.getByRole("button", { name: "Turn on shared control", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await band("shared").getByRole("button", { name: "Turn off shared control" }).waitFor();
    const after = (await api("GET", base)).body;
    expect(
      "the grant",
      after.granted.some((p) => p.userId === asker),
      after,
    );
    const left = await waiting.count();
    note(
      `step 3: turned on for the asker; granted names them, everyoneSince ${after.everyoneSince}; the row ${left === 0 ? "left" : "is still under"} Waiting on you`,
    );
    await both("box-owner-shared-on");
    const row = await details(id, "box-owner-details");
    await row.getByText(/has shared control\.$/).waitFor();
    await row.getByRole("button", { name: "Turn off shared control" }).waitFor();
    return;
  }

  if (!checker && view.granted.some((p) => p.userId === me.userId)) {
    // ─── 4. The second account sends; their own Codex login is refused ───
    await open(id);
    await band("steering").waitFor();
    note(`step 4: the band reads "${(await band("steering").innerText()).replace(/\s+/g, " ")}"`);
    await write(SECOND);
    await page.keyboard.press("Enter");
    const refused = visible(page.getByText(/so your message wasn't sent\./));
    await refused.waitFor({ timeout: 60_000 });
    const kept = await field().inputValue();
    expect("the words back in the box", kept === SECOND, kept);
    note(
      `step 4: the box refused it: "${(await refused.innerText()).trim()}"; the words are back in the box`,
    );
    await field().fill("");
    await both("box-second-login-refused");
    const row = await details(id, "box-second-details");
    await row.getByText(/shares control of this session with you\.$/).waitFor();
    return;
  }

  if (checker && view.granted.length > 0) {
    // ─── 5. The checker writes, then turns it off and tidies ───
    try {
      await open(id);
      await write(THIRD);
      await page.keyboard.press("Enter");
      await reply("again");
      await visible(page.getByText(/^You · /)).waitFor();
      note("step 5: the checker's own message reads You · <time>; Codex replied again");
      await page
        .getByRole("button", { name: /^Actions for / })
        .filter({ visible: true })
        .last()
        .click();
      const off = page.getByRole("menuitem", { name: "Turn off shared control" });
      await off.waitFor();
      await settled();
      await capture("box-owner-turn-off-menu-desktop-light");
      await off.click();
      await band("shared").waitFor({ state: "hidden" });
      await visible(page.getByText(/^You turned off shared control for .+ ·/)).waitFor();
      const ended = (await api("GET", base)).body;
      expect("the take-back", ended.granted.length === 0, ended);
      note("step 5: turned off from the tile's …; granted [], and the conversation marks it");
      await both("box-owner-turned-off");
    } finally {
      await api("POST", `/api/sessions/${id}/stop`);
      if (fixture !== undefined)
        await api("PUT", `/api/projects/${fixture.id}/visibility`, { visibility: "private" });
      note("step 5: stopped the session and put verify-fixture back to private");
    }
    return;
  }
  throw new Error("no step fits the server's state: see the notes above");
};
