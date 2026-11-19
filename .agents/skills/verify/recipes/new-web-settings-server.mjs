// Settings → Server in the new web app (route PR 58, SLNT-1173): `/settings/server`, for the
// server's operators.
//
//   pnpm verify drive new-web --recipe new-web-settings-server
//
// Feature ids: exposure.md `exposure-report` (the declaration and every gate item with how it was
// established) and `tenancy-gate` (the multi mode gate item by item, read-only), doctor.md
// `doctor-web-connection` (the Sealant connection with Check again), workspace-images.md
// `image-instance-default` (shown read-only: no editor), operator.md `org-list` (each organization
// with its member and owner counts; an ownerless one says "no owner").
//
// What is real and what is rewritten:
// - Real: everything the stack's operator (its first account) reads: the exposure report, the
//   machine view, `/health`, the instance settings, the multi mode gate, the organizations, and
//   the Sealant check as far as this stack's Sealant goes. Real too: the old addresses
//   (`/settings/instance/*`, `/settings/sealant`) landing here, and a second account that isn't an
//   operator, which has no Server in its sidebar, is sent to Profile, and gets 404 from the API.
// - Rewritten in the page (recorded answers, mapped by `apps/web/src/lib/server-settings.test.ts`):
//   the Sealant check running (held back), refusing the key, unreachable and answering as
//   something else; a section whose read fails (Try again); the organizations list empty and long;
//   the whole page loading.
//
// The recipe removes the member it adds.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const OLD_ADDRESSES = [
  "/settings/instance",
  "/settings/instance/environment",
  "/settings/instance/exposure",
  "/settings/instance/defaults",
  "/settings/sealant",
];
const SEALANT_WORDS = /^(Connected|Key refused|Not Sealant|Unreachable)$/;

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
const failure = {
  error: {
    json: {
      message: "The verify recipe failed this read on purpose.",
      code: -32603,
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
    },
  },
};
/** A tRPC answer carrying `json`, with superjson's note that `checkedAt` is a date. */
const sealantAnswer = (connection) => ({
  result: {
    data: {
      json: { ...connection, checkedAt: new Date(Date.now() - 2 * 60_000).toISOString() },
      meta: { values: { checkedAt: ["Date"] } },
    },
  },
});
const organizationsAnswer = (count) => {
  const at = new Date(2026, 2, 2).toISOString();
  const json = Array.from({ length: count }, (_, index) => ({
    organization: {
      id: `org-verify-${index}`,
      name: `Verify organization ${String(index + 1).padStart(2, "0")}`,
      createdByUserId: null,
      createdAt: at,
      updatedAt: at,
    },
    memberCount: 1 + (index % 7),
    ownerCount: index % 5 === 4 ? 0 : 1 + (index % 2),
  }));
  const values = {};
  json.forEach((_, index) => {
    values[`${index}.organization.createdAt`] = ["Date"];
    values[`${index}.organization.updatedAt`] = ["Date"];
  });
  return { result: { data: { json, ...(count === 0 ? {} : { meta: { values } }) } } };
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
  const section = (name) => visible(page.getByRole("region", { name, exact: true }));
  /** Answer every call to the named procedures in a batch with `answer(path)`; null keeps it. */
  const rewrite = (procedures, answer) =>
    page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.some((path) => procedures.includes(path))) return route.continue();
      const response = await route.fetch();
      const answers = await response.json();
      const list = Array.isArray(answers) ? answers : [answers];
      const changed = await Promise.all(
        paths.map(async (path, index) =>
          procedures.includes(path) ? ((await answer(path)) ?? list[index]) : list[index],
        ),
      );
      const failed = changed.some((one) => one?.error !== undefined);
      await route.fulfill({
        status: failed ? (paths.length === 1 ? 500 : 207) : response.status(),
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
      });
    });
  /** Open the page afresh through the router, so rewritten answers reach it. */
  const reopen = async () => {
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate("/settings/server");
    await heading("Server");
  };
  const operator = apiOf(page);

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const me = await operator("GET", "/api/organization");
  expect("the stack's first account is its operator", me.status === 200 && me.body.operator, me);

  // --- The page, as the operator (real) ----------------------------------------------------
  await open("/settings/server");
  await heading("Server");
  await visible(page.getByText("Operators of this server", { exact: true })).waitFor();
  const active = await page
    .locator('[data-slot="sidebar"][aria-label="Settings"] [aria-current="page"]')
    .first()
    .textContent();
  expect("the sidebar highlights Server", active?.trim() === "Server", active);
  const report = await operator("GET", "/api/operator/exposure");
  expect("the exposure report", report.status === 200, report.status);
  const exposure = section("Address and exposure");
  const checks = exposure.getByRole("table", { name: "Exposure checks" });
  await visible(checks).waitFor();
  const rows = await checks.getByRole("row").count();
  expect("every exposure item is listed", rows - 1 === report.body.items.length, {
    rows,
    items: report.body.items.length,
  });
  note(
    `exposure-report: declared ${report.body.declared}, ${report.body.items.length} items, ${report.body.items.filter((item) => item.established === "open").length} open`,
  );
  const gate = await operator("GET", "/api/operator/gate");
  const organizations = section("Organizations");
  await visible(organizations.getByRole("table", { name: "Multi-organization gate" })).waitFor();
  note(
    `tenancy-gate: ${gate.body.length} items read, ${gate.body.filter((item) => !item.ok).length} not in place; no control`,
  );
  const listed = await operator("GET", "/api/operator/organizations");
  for (const summary of listed.body)
    await visible(organizations.getByText(summary.organization.name, { exact: true })).waitFor();
  note(`org-list: ${listed.body.length} organization(s), each with member and owner counts`);
  const image = section("Starting workspace image");
  await visible(image.getByText("Image", { exact: true })).waitFor();
  const editors = await image.getByRole("button").count();
  expect("the starting image has no editor", editors === 0, editors);
  note("image-instance-default: the server's starting image, read-only, no editor");
  const runtimes = section("Runtimes");
  await visible(runtimes.getByText(SEALANT_WORDS)).waitFor({ timeout: 60_000 });
  const real = await operator("GET", "/api/sealant/connection");
  note(`doctor-web-connection (real): this stack's Sealant reads ${real.body.status}`);
  await shot("server-desktop-light");
  await paint("dark");
  await shot("server-desktop-dark");
  await paint("light");

  // Check again on the real connection: the row shows the new answer.
  await visible(runtimes.getByRole("button", { name: "Check again" })).click();
  await visible(runtimes.getByText(SEALANT_WORDS)).waitFor({ timeout: 60_000 });
  note("Check again asks Sealant again and the row shows the new answer");

  // --- The old addresses -------------------------------------------------------------------
  for (const address of OLD_ADDRESSES) {
    await navigate(address);
    await page.waitForURL((url) => url.pathname === "/settings/server");
    await heading("Server");
  }
  note(`old addresses land here: ${OLD_ADDRESSES.join(", ")}`);

  // --- The Sealant check: running, and each outcome (recorded answers) ----------------------
  await rewrite(["platform.sealantConnection"], async () => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    return null;
  });
  await visible(runtimes.getByRole("button", { name: "Check again" })).click();
  await visible(runtimes.getByText("Checking…", { exact: true })).waitFor();
  await runtimes.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  note("while the check runs (held back 4 s), the row and the button say Checking…");
  await capture("server-sealant-checking-desktop-light");
  await visible(runtimes.getByText(SEALANT_WORDS)).waitFor({ timeout: 30_000 });
  await page.unroute("**/trpc/**");

  const outcomes = [
    {
      name: "connected",
      word: "Connected",
      connection: { status: "connected", baseUrl: "http://sealant:7400", detail: null },
    },
    {
      name: "refused",
      word: "Key refused",
      connection: {
        status: "unauthorized",
        baseUrl: "http://sealant:7400",
        detail: "401 Unauthorized",
      },
    },
    {
      name: "unreachable",
      word: "Unreachable",
      connection: {
        status: "unreachable",
        baseUrl: "http://sealant:7400",
        detail: "connect ECONNREFUSED 10.0.4.12:7400",
      },
    },
    {
      name: "mismatched",
      word: "Not Sealant",
      connection: {
        status: "mismatched",
        baseUrl: "http://sealant:7400",
        detail: "404 Not Found at /v1/workspaces",
      },
    },
  ];
  for (const outcome of outcomes) {
    await rewrite(["platform.sealantConnection"], () => sealantAnswer(outcome.connection));
    await visible(runtimes.getByRole("button", { name: "Check again" })).click();
    await visible(runtimes.getByText(outcome.word, { exact: true })).waitFor();
    await runtimes.scrollIntoViewIfNeeded();
    note(`Sealant ${outcome.connection.status} (recorded) reads "${outcome.word}"`);
    await shot(`server-sealant-${outcome.name}-desktop-light`);
    await page.unroute("**/trpc/**");
  }

  // --- A section whose read fails, and Try again -------------------------------------------
  await rewrite(["operator.organizations"], () => failure);
  await reopen();
  const failed = section("Organizations");
  await visible(failed.getByText("This didn't load.", { exact: true })).waitFor();
  await visible(
    section("Address and exposure").getByRole("table", { name: "Exposure checks" }),
  ).waitFor();
  await failed.scrollIntoViewIfNeeded();
  note(
    "the organizations read fails (rewritten): its section says so with Try again; the rest stand",
  );
  await shot("server-organizations-failed-desktop-light");
  await page.unroute("**/trpc/**");
  await visible(failed.getByRole("button", { name: "Try again" })).click();
  await visible(failed.getByRole("list", { name: "Organizations on this server" })).waitFor();
  note("Try again reads the organizations and the list draws");

  // --- The organizations list empty and long (rewritten) -----------------------------------
  await rewrite(["operator.organizations"], () => organizationsAnswer(0));
  await reopen();
  await visible(
    section("Organizations").getByText("No organizations yet", { exact: true }),
  ).waitFor();
  await section("Organizations").scrollIntoViewIfNeeded();
  note("an empty organizations list (rewritten) says so");
  await shot("server-organizations-empty-desktop-light");
  await page.unroute("**/trpc/**");

  await rewrite(["operator.organizations"], () => organizationsAnswer(30));
  await reopen();
  const long = section("Organizations").getByRole("list", { name: "Organizations on this server" });
  await visible(long.getByText("Verify organization 30", { exact: true })).waitFor();
  await visible(long.getByText("2 members, no owner", { exact: true })).waitFor();
  await long.getByText("Verify organization 30", { exact: true }).scrollIntoViewIfNeeded();
  note("a long list (30, rewritten) scrolls in the sheet; an ownerless one says no owner");
  await shot("server-organizations-long-desktop-light");
  await page.unroute("**/trpc/**");

  // --- The whole page loading --------------------------------------------------------------
  await rewrite(["platform.exposure"], async () => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    return null;
  });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  void navigate("/settings/server");
  await visible(page.getByText("Reading the exposure report…", { exact: true })).waitFor();
  await page.evaluate(() =>
    document.querySelectorAll(".overflow-y-auto").forEach((element) => element.scrollTo(0, 0)),
  );
  await page.waitForTimeout(400);
  note("while a section's read runs (held back 4 s), the section says what it is reading");
  await capture("server-loading-desktop-light");
  await visible(page.getByRole("table", { name: "Exposure checks" })).waitFor({ timeout: 30_000 });
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // --- Someone who isn't an operator: no Server, refused by address ------------------------
  const invitation = await operator("POST", "/api/organization/invitations", { role: "member" });
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
      .fill(`verify-server-${Date.now()}@example.invalid`);
    for (const label of ["Password", "Confirm password"])
      await typeSecret(
        memberPage.getByLabel(label, { exact: true }),
        "member-password",
        "a-server-verify-password",
      );
    await memberPage.getByRole("button", { name: "Create account and join", exact: true }).click();
    await memberPage.waitForURL((url) => url.pathname === "/welcome");
    memberId = (await apiOf(memberPage)("GET", "/api/organization")).body?.userId ?? null;
    const operatorCookies = await page.context().cookies();
    await page.context().clearCookies();
    await page.context().addCookies(await second.cookies());
    await page.setViewportSize(DESKTOP);
    await open("/settings/server");
    await page.waitForURL((url) => url.pathname === "/settings/profile");
    await heading("Profile");
    const entries = await page
      .locator('[data-slot="sidebar"][aria-label="Settings"]')
      .first()
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? ""));
    expect("a member's sidebar has no Server", !entries.includes("Server"), entries);
    await navigate("/settings/instance/exposure");
    await page.waitForURL((url) => url.pathname === "/settings/profile");
    const refused = await apiOf(page)("GET", "/api/operator/organizations");
    expect(
      "the server answers someone who isn't an operator 404",
      refused.status === 404,
      refused.status,
    );
    note(
      "not an operator: no Server in the sidebar; /settings/server and the old addresses go to Profile; the API answers 404",
    );
    await shot("server-member-refused-desktop-light");
    await page.context().clearCookies();
    await page.context().addCookies(operatorCookies);
    await open("/settings/profile");
  } finally {
    if (memberId !== null) await operator("DELETE", `/api/organization/members/${memberId}`);
    await second.close();
  }

  // --- The phone ---------------------------------------------------------------------------
  await page.setViewportSize(PHONE);
  await open("/settings/server");
  await visible(page.getByText("Operators of this server", { exact: true })).waitFor();
  await visible(section("Runtimes").getByText(SEALANT_WORDS)).waitFor({ timeout: 60_000 });
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`server-phone-${theme}`);
  }
  await paint("light");
};
