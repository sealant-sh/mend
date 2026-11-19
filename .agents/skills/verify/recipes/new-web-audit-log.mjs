// The organization's Audit log in the new web app (route PR 51, SLNT-1164):
// `/settings/organization/audit-log`, for the organization's owners.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-shared-control-setup.json
//   pnpm verify drive new-web --recipe new-web-audit-log
//
// The CLI batch first starts a `mend run` session and turns its shared control on and off, so the
// log holds real shared-control events; without it the recipe says so and goes on.
//
// Feature ids: operator.md `operator-audit` (each act is in the organization's log, worded "as
// this server's operator"; the sentence is unit-tested in `apps/web/src/lib/audit-log.test.ts`,
// since a stack's operator acts in its own organization), shared-control.md `audit` (sharing
// control of a session, real here), organization.md `audit-log` (newest first, with older pages).
//
// What is real and what is rewritten:
// - Real: the events. The recipe makes them through the stack's API as its owner: shared control
//   of a session turned on and off (the CLI batch's session, when there is one), verify-fixture
//   shared and made private again, and enough invitation links created and revoked that the log
//   needs a second page, which Show older events reads.
// - Rewritten in the page: an empty log (a stack always has events), the loading state (the
//   first page held back for a moment), a first page that fails (Try again), and an older page that
//   fails (said under the button).
//
// The recipe leaves verify-fixture private, every link it made revoked, and removes the member
// it adds to show that a member can't open the page.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
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
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");
/** The `before` a batched call asked for, if any. */
const beforeOf = (request, index) => {
  const url = new URL(request.url());
  const raw = url.searchParams.get("input") ?? request.postData() ?? "{}";
  try {
    const body = JSON.parse(raw);
    const entry = body[String(index)] ?? body;
    return (entry?.json ?? entry)?.before;
  } catch {
    return undefined;
  }
};
const failure = {
  error: {
    json: {
      message: "The verify recipe failed this read on purpose.",
      code: -32603,
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
    },
  },
};

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const settled = () => page.waitForTimeout(500);
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  };
  const open = async (to) => {
    await page.goto(`${web}${to}`);
    await hydrated();
    await page.waitForTimeout(1_000);
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  const navigate = (to) => page.evaluate((href) => window["__TSR_ROUTER__"].navigate({ href }), to);
  const clearCache = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await settled();
    await capture(name);
  };
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const owner = apiOf(page);
  const log = () => visible(page.getByRole("table", { name: "Audit log" }));
  const rowsShown = () => log().getByRole("row").count();
  /** Answer every `organization.audit` call in a batch with `answer(index, before)`. */
  const rewriteAudit = (answer) =>
    page.route("**/trpc/**", async (route) => {
      const request = route.request();
      const paths = pathsOf(request);
      if (!paths.includes("organization.audit")) return route.continue();
      const response = await route.fetch();
      const answers = await response.json();
      const list = Array.isArray(answers) ? answers : [answers];
      const changed = await Promise.all(
        paths.map(async (p, index) =>
          p === "organization.audit"
            ? ((await answer(index, beforeOf(request, index))) ?? list[index])
            : list[index],
        ),
      );
      const failed = changed.some((one) => one?.error !== undefined);
      await route.fulfill({
        status: failed ? (paths.length === 1 ? 500 : 207) : response.status(),
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
      });
    });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const me = await owner("GET", "/api/organization");
  expect("the owner", me.status === 200 && me.body.role === "owner", me);
  const organization = me.body.organization.name;

  // --- Real events --------------------------------------------------------------------------
  const projects = await owner("GET", "/api/projects");
  const fixture = (projects.body ?? []).find((project) => project.name === "verify-fixture");
  if (fixture !== undefined) {
    for (const visibility of ["shared", "private"]) {
      const set = await owner("PUT", `/api/projects/${fixture.id}/visibility`, { visibility });
      expect(`verify-fixture ${visibility}`, set.status === 200, set);
    }
    note("verify-fixture shared with everyone, then made private again");
  }
  const sessions = await owner("GET", "/api/sessions");
  const session = (sessions.body ?? []).find((row) => row.ownerUserId === me.body.userId);
  if (session !== undefined) {
    for (const on of [true, false]) {
      const shared = await owner("PUT", `/api/sessions/${session.id}/shared-control`, {
        enabled: on,
      });
      note(
        `shared control of session ${session.id.slice(0, 8)} ${on ? "on" : "off"}: ${shared.status}`,
      );
    }
  } else {
    note("no session of the owner's on this stack: shared control is shown by the unit test only");
  }
  const before = await owner("GET", "/api/organization/audit?limit=200");
  const needed = Math.max(0, 52 - (before.body ?? []).length);
  for (let made = 0; made < needed; made += 2) {
    const link = await owner("POST", "/api/organization/invitations", { role: "member" });
    expect("an invitation", link.status === 200, link.status);
    const revoked = await owner(
      "DELETE",
      `/api/organization/invitations/${link.body.invitation.id}`,
    );
    expect("revoked", revoked.status === 200, revoked.status);
  }
  const after = await owner("GET", "/api/organization/audit?limit=200");
  note(`the log holds ${(after.body ?? []).length} events (${needed} made by this run's links)`);

  // --- The page -------------------------------------------------------------------------------
  await open("/settings/organization/audit-log");
  await heading("Audit log");
  await visible(page.getByText(`Owners of ${organization}`, { exact: true })).waitFor();
  const active = await page
    .locator('[data-slot="sidebar"][aria-label="Settings"] [aria-current="page"]')
    .first()
    .textContent();
  expect("the sidebar highlights Audit log", active?.trim() === "Audit log", active);
  await visible(log().getByText("Revoked an invitation link")).waitFor();
  if (fixture !== undefined)
    await visible(log().getByText("Made verify-fixture private")).waitFor();
  const first = await rowsShown();
  note(`first page: ${first - 1} events, newest first, each with who, what, project and when`);
  await shot("audit-desktop-light");
  await visible(page.getByRole("button", { name: "Show older events" })).click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[role="table"][aria-label="Audit log"] [role="row"]').length >
      count,
    first,
  );
  note(`Show older events reads the next page: ${(await rowsShown()) - 1} events shown`);
  await page
    .getByText(`That's everything since ${organization} began.`)
    .or(page.getByRole("button", { name: "Show older events" }))
    .first()
    .waitFor();
  await page
    .locator('[role="table"][aria-label="Audit log"] [role="row"]')
    .last()
    .scrollIntoViewIfNeeded();
  await shot("audit-older-desktop-light");
  await paint("dark");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("audit-desktop-dark");
  await paint("light");

  // --- An older page that fails ----------------------------------------------------------------
  await rewriteAudit((_, before) => (before === undefined ? null : failure));
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/organization/audit-log");
  await heading("Audit log");
  await visible(page.getByRole("button", { name: "Show older events" })).click();
  await visible(page.getByText(/^Mend couldn't read older events\./)).waitFor();
  note("an older page that fails is said under the button, and the events already read stay");
  await shot("audit-older-failed-desktop-light");
  await page.unroute("**/trpc/**");

  // --- Empty, loading, and a first page that fails ---------------------------------------------
  await rewriteAudit(() => ({ result: { data: { json: [] } } }));
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/organization/audit-log");
  await visible(page.getByText(/^Nothing recorded yet\./)).waitFor();
  note("an empty log (rewritten) says so");
  await shot("audit-empty-desktop-light");
  await page.unroute("**/trpc/**");

  await rewriteAudit(async () => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    return null;
  });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  void navigate("/settings/organization/audit-log");
  await page.waitForTimeout(1_200);
  note("while the first page loads (held back 4 s), the page shows the loading screen");
  await capture("audit-loading-desktop-light");
  await heading("Audit log");
  await page.unroute("**/trpc/**");

  await rewriteAudit(() => failure);
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/organization/audit-log");
  await heading("This page didn't load");
  note("a first page that fails shows the error screen with Try again");
  await shot("audit-error-desktop-light");
  await page.unroute("**/trpc/**");
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("Audit log");
  note("Try again reads the log and it draws");

  // --- A member: no Audit log in the sidebar, and refused by address --------------------------
  const invitation = await owner("POST", "/api/organization/invitations", { role: "member" });
  expect("an invitation for the member", invitation.status === 200, invitation.status);
  registerSecret("invitation-token", invitation.body.token);
  const second = await page.context().browser().newContext();
  const memberPage = await second.newPage();
  let memberId = null;
  try {
    await memberPage.goto(`${web}/join#${invitation.body.token}`);
    await memberPage.getByRole("heading", { name: /^Join / }).waitFor();
    await memberPage.getByRole("textbox", { name: "Name" }).fill("Mae Verify");
    await memberPage
      .getByRole("textbox", { name: "Email" })
      .fill(`verify-audit-${Date.now()}@example.invalid`);
    for (const label of ["Password", "Confirm password"])
      await typeSecret(
        memberPage.getByLabel(label, { exact: true }),
        "member-password",
        "an-audit-verify-password",
      );
    await memberPage.getByRole("button", { name: "Create account and join", exact: true }).click();
    await memberPage.waitForURL((url) => url.pathname === "/welcome");
    memberId = (await apiOf(memberPage)("GET", "/api/organization")).body?.userId ?? null;
    const ownerCookies = await page.context().cookies();
    await page.context().clearCookies();
    await page.context().addCookies(await second.cookies());
    await page.setViewportSize(DESKTOP);
    await open("/settings/organization/audit-log");
    await page.waitForURL((url) => url.pathname === "/settings/profile");
    await heading("Profile");
    const entries = await page
      .locator('[data-slot="sidebar"][aria-label="Settings"]')
      .first()
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? ""));
    expect("a member's sidebar has no Audit log", !entries.includes("Audit log"), entries);
    const refused = await apiOf(page)("GET", "/api/organization/audit");
    expect("the server answers a member 404", refused.status === 404, refused.status);
    note("a member: no Audit log in the sidebar; its address goes to Profile; the API answers 404");
    await shot("audit-member-refused-desktop-light");
    await page.context().clearCookies();
    await page.context().addCookies(ownerCookies);
  } finally {
    if (memberId !== null) await owner("DELETE", `/api/organization/members/${memberId}`);
    await second.close();
  }

  // --- The phone ------------------------------------------------------------------------------
  await page.setViewportSize(PHONE);
  await open("/settings/organization/audit-log");
  await visible(page.getByRole("heading", { name: "Audit log" })).waitFor();
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`audit-phone-${theme}`);
  }
  await paint("light");
};
