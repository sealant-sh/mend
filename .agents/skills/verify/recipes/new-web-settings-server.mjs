// Settings → Server in the new web app (route PR 58, SLNT-1173; redone in SLNT-1195):
// `/settings/server`, for the server's operators.
//
//   pnpm verify drive new-web --recipe new-web-settings-server
//
// Feature ids: exposure.md `exposure-report` (the declaration, then the checks: on a private server
// what going public would change and what is in place, closed; on a public one, what isn't in
// place under "Needs you") and `tenancy-gate` (the multi mode gate the same way, read-only),
// doctor.md `doctor-web-connection` (the Sealant connection with Check again; not connected, it
// moves to "Needs you"), workspace-images.md `image-instance-default` (shown read-only: no
// editor), operator.md `org-list` (each organization with its member and owner counts; an
// ownerless one says "no owner").
//
// What is real and what is rewritten:
// - Real: everything the stack's operator (its first account) reads: the exposure report with each
//   check's case and data, the machine view, `/health`, the instance settings, the multi mode gate,
//   the organizations, and the Sealant check as far as this stack's Sealant goes. Real too: the old
//   addresses (`/settings/instance/*`, `/settings/sealant`) landing here, and a second account that
//   isn't an operator, which has no Server in its sidebar, is sent to Profile, and gets 404 from the
//   API.
// - Rewritten in the page (recorded answers, worded by `apps/web/src/lib/server-settings.ts` and
//   mapped by its test): a server offering Boat with a key of its own (the frames' server), the
//   Sealant check held back, unreachable, and Boat refusing the server's key ("Needs you"); a public
//   server on Kubernetes with several organizations and every check in place; the same server
//   public with the stack's real open checks; a section whose read fails (Try again); the whole
//   page loading.
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
const SECTIONS = [
  "This server",
  "Who can reach it",
  "Where sessions run",
  "Starting workspace image",
  "Organizations",
  "Storage and connections",
];

const visible = (locator) => locator.filter({ visible: true }).first();
const textOf = (locator) => locator.evaluate((element) => element.textContent ?? "");
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
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A tRPC answer carrying `json`, with superjson's notes on which fields are dates. */
const answerOf = (json, dates = []) => ({
  result: {
    data: {
      json,
      ...(dates.length === 0
        ? {}
        : { meta: { values: Object.fromEntries(dates.map((path) => [path, ["Date"]])) } }),
    },
  },
});

const sealantAnswer = (connection) =>
  answerOf({ ...connection, checkedAt: minutesAgo(1) }, ["checkedAt"]);

/** What Boat sends a refused key, as sealant reports it (`key-refused`). */
const REFUSED = {
  observed: false,
  reason: "refused",
  boat: {
    kind: "key-refused",
    retryable: false,
    operation: "me",
    status: 401,
    code: "invalid_api_key",
    message: "API key is not valid.",
    requestId: "req_verify1",
    permission: null,
    retryAfterSeconds: null,
    retryAt: null,
    billingUrl: null,
  },
};

/** The permissions Mend asks of every Boat key (`BOAT_KEY_REQUIRED_PERMISSIONS` in @mend/domain). */
const PERMISSIONS = [
  "exec",
  "file.write",
  "host",
  "sandbox.create",
  "sandbox.delete",
  "sandbox.read",
  "sandbox.resume",
  "sandbox.stop",
  "snapshot.read",
  "snapshot.write",
  "account.read",
];

/** A server Boat key report shaped as sealant answers it; refused, every fact Boat withheld. */
const keyReport = (refused) => {
  const report = {
    observedAt: minutesAgo(240),
    organization: null,
    identity: {
      observed: true,
      accountId: "acct_verify",
      login: "northwind-ci",
      displayName: "Northwind CI",
      serviceAccount: true,
      accountStatus: "active",
    },
    keyKind: { observed: true, kind: "personal" },
    wallet: {
      observed: true,
      kind: "organization",
      organizationId: "org_verify",
      organizationName: "Northwind",
      role: "admin",
    },
    wallets: null,
    billing: { mode: "pinned", organization: "org_verify" },
    requiredPermissions: PERMISSIONS,
    permissions: { observed: true, held: PERMISSIONS, missing: [], limitedToSandboxes: false },
    expiry: {
      observed: true,
      expiresAt: new Date(Date.now() + 200 * 86_400_000).toISOString(),
      expired: false,
      expiringSoon: false,
    },
    start: {
      observed: true,
      canStart: true,
      blockedReason: null,
      billingStatus: "active",
      runningVms: 1,
      allowedVms: 5,
    },
    snapshots: { observed: true, used: 2, included: 10 },
  };
  return refused
    ? {
        ...report,
        identity: REFUSED,
        keyKind: REFUSED,
        wallet: REFUSED,
        permissions: REFUSED,
        expiry: REFUSED,
        start: REFUSED,
        snapshots: REFUSED,
      }
    : report;
};

/**
 * The stack's machine view with Boat offered and the default (the frames' server): both public
 * addresses answered, the server's own key held (refused, or checked and fine, or none at all),
 * and Sealant listing Boat with the resource gateway.
 */
const withBoat = (stack, { key, docker = true }) => {
  const json = stack.result.data.json;
  const machine = {
    ...json,
    sessionRuntimes: { offered: docker ? ["docker", "boat"] : ["boat"], default: "boat" },
    boat: {
      addresses: [
        {
          purpose: "sessions",
          url: "https://boat.mend.northwind.dev",
          answer: { answered: true, status: 404 },
          observedAt: minutesAgo(4),
        },
        {
          purpose: "saved-work",
          url: "https://saved.mend.northwind.dev",
          answer: { answered: true, status: 403 },
          observedAt: minutesAgo(4),
        },
      ],
      serverKey:
        key === "none"
          ? { state: "none" }
          : { state: "held", unreachable: null, report: keyReport(key === "refused") },
      storedKeys: 1,
      launch: { state: "listed", observedAt: minutesAgo(4), resourceGateway: true },
    },
  };
  const dates = [
    ...Object.keys(stack.result.data.meta?.values ?? {}),
    "boat.addresses.0.observedAt",
    "boat.addresses.1.observedAt",
    "boat.launch.observedAt",
    ...(key === "none"
      ? []
      : [
          "boat.serverKey.report.observedAt",
          ...(key === "fine" ? ["boat.serverKey.report.expiry.expiresAt"] : []),
        ]),
  ];
  return answerOf(machine, dates);
};

const exposureItem = (item, established, blocksStart = true) => ({
  ...item,
  established,
  blocksStart,
  detail: "the command line's sentence",
  fix: null,
});

/** A public server with every check in place: what the frames' public server reports. */
const PUBLIC_IN_PLACE = (version) => ({
  declared: "public",
  items: [
    exposureItem({ id: "https-origin", reason: "all-https", originCount: 1 }, "observed"),
    exposureItem({ id: "secure-cookies", reason: "secure" }, "observed"),
    exposureItem({ id: "trusted-proxies", reason: "ranges", rangeCount: 1 }, "observed"),
    exposureItem({ id: "enrollment-closed", reason: "built-in" }, "carried", false),
    exposureItem({ id: "tenancy-gate", reason: "complete" }, "observed"),
    exposureItem({ id: "budgets", reason: "all-set" }, "observed"),
    exposureItem({ id: "no-bearers-in-urls", reason: "refused" }, "observed"),
    exposureItem({ id: "browser-headers", reason: "built-in" }, "carried", false),
    exposureItem({ id: "error-redaction", reason: "redacted" }, "observed"),
    exposureItem({ id: "executor-channel-transport", reason: "https" }, "observed"),
    exposureItem({ id: "workspace-ssh", reason: "unpublished" }, "observed"),
    exposureItem({ id: "core-private", reason: "outside-view", mirrors: [] }, "declared", false),
    exposureItem({ id: "edge-tls", reason: "outside-view" }, "declared", false),
    exposureItem({ id: "reassessment", reason: "reviewed", version }, "declared", false),
  ],
});

const gateItem = (item) => ({
  ...item,
  ok: true,
  detail: "the command line's sentence",
  fix: null,
});

const GATE_IN_PLACE = [
  gateItem({ id: "cross-organization-authorization", reason: "built-in" }),
  gateItem({ id: "per-account-resources", reason: "built-in" }),
  gateItem({ id: "folders-reach-workspaces", reason: "captured" }),
  gateItem({ id: "source-policy", reason: "tenant" }),
  gateItem({ id: "source-address-pinning", reason: "tenant" }),
  gateItem({ id: "transport-bound-to-origin", reason: "bound" }),
  gateItem({ id: "upload-length-binding", reason: "enforced" }),
  gateItem({ id: "daemon-declares-sizes", reason: "built-in" }),
  gateItem({ id: "raw-service-ports", reason: "loopback" }),
  gateItem({ id: "operator-present", reason: "operators", count: 2 }),
];

const organizationsAnswer = (list) => {
  const json = list.map(([name, memberCount, ownerCount, created], index) => ({
    organization: {
      id: `org-verify-${index}`,
      name,
      createdByUserId: null,
      createdAt: created,
      updatedAt: created,
    },
    memberCount,
    ownerCount,
  }));
  return answerOf(
    json,
    json.flatMap((_, index) => [
      `${index}.organization.createdAt`,
      `${index}.organization.updatedAt`,
    ]),
  );
};

const THREE_ORGANIZATIONS = [
  ["Northwind", 4, 2, new Date(2026, 2, 3).toISOString()],
  ["Acme Labs", 2, 1, new Date(2026, 5, 9).toISOString()],
  ["Initech", 1, 0, new Date(2026, 10, 2).toISOString()],
];

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
  const top = () =>
    page.evaluate(() =>
      document.querySelectorAll(".overflow-y-auto").forEach((element) => element.scrollTo(0, 0)),
    );
  /**
   * The whole page in one picture: the sheet scrolls inside itself, so the window grows to the
   * sheet's full height for the capture, then goes back.
   */
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await top();
    const size = page.viewportSize();
    const tall = await page.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll(".overflow-y-auto")].map(
          (element) => element.scrollHeight - element.clientHeight,
        ),
        0,
      ),
    );
    if (size !== null && tall > 0)
      await page.setViewportSize({ width: size.width, height: Math.min(size.height + tall, 9000) });
    await settled();
    await capture(name);
    if (size !== null && tall > 0) await page.setViewportSize(size);
  };
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const section = (name) => visible(page.getByRole("region", { name, exact: true }));
  /**
   * Answer every call to the named procedures in a batch with `answer(path, real)`, where `real` is
   * what the stack answered; null keeps the stack's answer.
   */
  const rewrite = (answers) =>
    page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.some((path) => path in answers)) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      const list = Array.isArray(body) ? body : [body];
      const changed = await Promise.all(
        paths.map(async (path, index) =>
          path in answers ? ((await answers[path](list[index])) ?? list[index]) : list[index],
        ),
      );
      const failed = changed.some((one) => one?.error !== undefined);
      await route.fulfill({
        status: failed ? (paths.length === 1 ? 500 : 207) : response.status(),
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(body) ? changed : changed[0]),
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
  /** Open every closed list on the page. */
  const openAll = async () => {
    const closed = page.locator('[data-slot="collapsible-trigger"][aria-expanded="false"]');
    while ((await closed.count()) > 0) {
      await closed.first().click();
      await page.waitForTimeout(150);
    }
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
  for (const name of SECTIONS) await section(name).waitFor();
  const report = await operator("GET", "/api/operator/exposure");
  expect("the exposure report", report.status === 200, report.status);
  expect(
    "every exposure item names its case",
    report.body.items.every((item) => typeof item.reason === "string"),
    report.body.items.map((item) => [item.id, item.reason]),
  );
  const openChecks = report.body.items.filter((item) => item.established === "open");
  note(
    `exposure-report: declared ${report.body.declared}, ${report.body.items.length} items, ${openChecks.length} open; cases ${report.body.items.map((item) => `${item.id}=${item.reason}`).join(", ")}`,
  );
  const reach = section("Who can reach it");
  await visible(reach.getByText(/^Mend checked this server /)).waitFor();
  if (report.body.declared !== "public" && openChecks.length > 0) {
    await visible(
      reach.getByText(
        new RegExp(
          `^Before this server could go public, (${openChecks.length}|one) things? would have to change\\.$`,
        ),
      ),
    ).waitFor();
  }
  const reachText = await textOf(reach);
  expect(
    "the checks are closed and no check id is a row's name",
    !reachText.includes("executor-channel-transport"),
    reachText,
  );
  expect(
    "nothing needs the operator on a private server with Sealant connected, or Needs you lists why",
    report.body.declared === "public" ||
      (await page.getByRole("region", { name: "Needs you", exact: true }).count()) === 0 ||
      (await operator("GET", "/api/sealant/connection")).body?.status !== "connected",
    report.body.declared,
  );
  note(
    "who-can-reach-it (real): the declaration with how it is set, the checks closed in two lines",
  );
  const gate = await operator("GET", "/api/operator/gate");
  expect(
    "every gate item names its case",
    gate.body.every((item) => typeof item.reason === "string"),
    gate.body.map((item) => [item.id, item.reason]),
  );
  const missing = gate.body.filter((item) => !item.ok).length;
  const organizations = section("Organizations");
  if (missing > 0)
    await visible(
      organizations.getByText(/^Before this server could run several organizations, /),
    ).waitFor();
  note(
    `tenancy-gate: ${gate.body.length} items read, ${missing} not in place, behind one closed line; cases ${gate.body.map((item) => `${item.id}=${item.reason}`).join(", ")}`,
  );
  const listed = await operator("GET", "/api/operator/organizations");
  for (const summary of listed.body)
    await visible(organizations.getByText(summary.organization.name, { exact: true })).waitFor();
  note(`org-list: ${listed.body.length} organization(s), each with member and owner counts`);
  const image = section("Starting workspace image");
  const editors = await image
    .getByRole("button")
    .and(page.locator(':not([data-slot="collapsible-trigger"])'))
    .count();
  expect("the starting image has no editor", editors === 0, editors);
  note("image-instance-default: the server's starting image named by what it is, read-only");
  const real = await operator("GET", "/api/sealant/connection");
  note(`doctor-web-connection (real): this stack's Sealant reads ${real.body.status}`);
  await shot("server-real-desktop-light");
  await openAll();
  await visible(reach.getByRole("list", { name: "Checks in place" })).waitFor();
  note("opened (real): every list opens; each check has a plain title, its id small beside it");
  await shot("server-real-open-desktop-light");

  // --- The frames' server: private, Boat offered with a key of its own, all closed ---------
  const connected = { status: "connected", baseUrl: "http://sealant:8080", detail: null };
  await rewrite({
    "platform.machine": (stack) => withBoat(stack, { key: "fine" }),
    "platform.sealantConnection": () => sealantAnswer(connected),
  });
  await reopen();
  const thisServer = section("This server");
  await visible(thisServer.getByText("Connected", { exact: true })).waitFor();
  const sessions = section("Where sessions run");
  await visible(sessions.getByText(/^This server has a Boat key of its own\./)).waitFor();
  await visible(sessions.getByRole("button", { name: "Check the key now" })).waitFor();
  expect(
    "nothing needs the operator",
    (await page.getByRole("region", { name: "Needs you", exact: true }).count()) === 0,
    "Needs you drawn",
  );
  note(
    "private server, Sealant connected, Boat offered with its key fine (recorded): no Needs you; Boat's facts as sentences",
  );
  await shot("server-private-closed-desktop-light");
  await paint("dark");
  await shot("server-private-closed-desktop-dark");
  await paint("light");
  await openAll();
  await visible(page.getByText(/^Mend won't start in public until|^None of them stops/)).waitFor();
  note(
    "the three lists open: what going public would change (with its first line), in place, the gate",
  );
  await shot("server-private-open-desktop-light");

  // --- Sealant checking --------------------------------------------------------------------
  await page.unroute("**/trpc/**");
  await rewrite({
    "platform.machine": (stack) => withBoat(stack, { key: "fine" }),
    "platform.sealantConnection": async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return sealantAnswer(connected);
    },
  });
  await visible(thisServer.getByRole("button", { name: "Check again" })).click();
  await visible(thisServer.getByText("Checking…", { exact: true }).first()).waitFor();
  note("while the check runs (held back 4 s), the row and its button say Checking…");
  await top();
  await page.waitForTimeout(300);
  await capture("server-sealant-checking-desktop-light");
  await visible(thisServer.getByText("Connected", { exact: true })).waitFor({ timeout: 30_000 });
  await page.unroute("**/trpc/**");

  // --- Needs you: Sealant unreachable, Boat refusing the server's key ---------------------
  await rewrite({
    "platform.machine": (stack) => withBoat(stack, { key: "refused" }),
    "platform.sealantConnection": () =>
      sealantAnswer({
        status: "unreachable",
        baseUrl: "http://sealant:8080",
        detail: "connect ECONNREFUSED 172.18.0.4:8080",
      }),
  });
  await reopen();
  const needs = section("Needs you");
  await visible(needs.getByText("Sealant can't be reached", { exact: true })).waitFor();
  await visible(needs.getByText("Boat refused this server's key", { exact: true })).waitFor();
  await visible(needs.getByRole("button", { name: "Check again" })).waitFor();
  await visible(needs.getByRole("button", { name: "Check the key now" })).waitFor();
  expect(
    "Sealant leaves This server while it isn't connected",
    (await section("This server").getByText("Sealant", { exact: true }).count()) === 0,
    "a Sealant row in This server",
  );
  await visible(
    section("Where sessions run").getByText(
      "Boat refused this server's own key when Sealant last checked it. What to do is under Needs you.",
    ),
  ).waitFor();
  note(
    "Needs you (recorded): Sealant unreachable with what Mend asked and saw, and Boat refusing the server's key, each with its fix and its check; the Boat row points there",
  );
  await shot("server-needs-you-desktop-light");
  await page.setViewportSize(PHONE);
  await settled();
  await shot("server-needs-you-phone-light");
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**");

  // --- A public server on Kubernetes with several organizations, every check in place -----
  const health = await operator("GET", "/api/health");
  const version = health.body?.version ?? "0.36.0";
  note(`/api/health still counts the exposure checks: ${JSON.stringify(health.body?.exposure)}`);
  await rewrite({
    "platform.exposure": () => answerOf(PUBLIC_IN_PLACE(version)),
    "platform.health": (stack) =>
      answerOf({ ...stack.result.data.json, tenancy: "multi", deploymentMode: "kubernetes" }),
    "platform.machine": (stack) => withBoat(stack, { key: "none", docker: false }),
    "platform.sealantConnection": () => sealantAnswer(connected),
    "operator.gate": () => answerOf(GATE_IN_PLACE),
    "operator.organizations": () => organizationsAnswer(THREE_ORGANIZATIONS),
  });
  await reopen();
  const publicReach = section("Who can reach it");
  await visible(publicReach.getByText("Public", { exact: true })).waitFor();
  await visible(publicReach.getByText("All 14 checks are in place.", { exact: true })).waitFor();
  await visible(
    section("Organizations").getByText(
      "All 10 things Mend needs to run several organizations are in place.",
      { exact: true },
    ),
  ).waitFor();
  await visible(
    section("Organizations").getByText("1 member, no owner", { exact: true }),
  ).waitFor();
  await visible(
    section("Organizations").getByText("Who may create one", { exact: true }),
  ).waitFor();
  expect(
    "nothing needs the operator",
    (await page.getByRole("region", { name: "Needs you", exact: true }).count()) === 0,
    "Needs you drawn",
  );
  note(
    "public, Kubernetes, several organizations, every check in place (recorded): one closed line each; Helm named for how it's set; Initech says no owner",
  );
  await shot("server-public-several-desktop-light");
  await page.unroute("**/trpc/**");

  // The same server public with the stack's real checks: every open one needs the operator.
  if (openChecks.length > 0) {
    await rewrite({
      "platform.exposure": (stack) => answerOf({ ...stack.result.data.json, declared: "public" }),
    });
    await reopen();
    const publicNeeds = section("Needs you");
    await publicNeeds.waitFor();
    const listedOpen = await publicNeeds.getByRole("listitem").count();
    expect("each open check needs the operator", listedOpen >= openChecks.length, {
      listedOpen,
      open: openChecks.length,
    });
    note(
      `public with the stack's ${openChecks.length} open checks (recorded declaration): each in Needs you`,
    );
    await shot("server-public-open-desktop-light");
    await page.unroute("**/trpc/**");
  }

  // --- The old addresses -------------------------------------------------------------------
  await reopen();
  for (const address of OLD_ADDRESSES) {
    await navigate(address);
    await page.waitForURL((url) => url.pathname === "/settings/server");
    await heading("Server");
  }
  note(`old addresses land here: ${OLD_ADDRESSES.join(", ")}`);

  // --- A section whose read fails, and Try again -------------------------------------------
  await rewrite({ "operator.organizations": () => failure });
  await reopen();
  const failed = section("Organizations");
  await visible(failed.getByText("This didn't load.", { exact: true })).waitFor();
  await visible(section("Who can reach it").getByText(/^Mend checked this server /)).waitFor();
  note(
    "the organizations read fails (rewritten): its section says so with Try again; the rest stand",
  );
  await shot("server-organizations-failed-desktop-light");
  await page.unroute("**/trpc/**");
  await visible(failed.getByRole("button", { name: "Try again" })).click();
  await visible(failed.getByRole("list", { name: "Organizations on this server" })).waitFor();
  note("Try again reads the organizations and the list draws");

  // --- The whole page loading --------------------------------------------------------------
  await rewrite({
    "platform.exposure": async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return null;
    },
  });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  void navigate("/settings/server");
  await visible(page.getByText("Reading what Mend checked…", { exact: true })).waitFor();
  await top();
  await page.waitForTimeout(400);
  note("while a section's read runs (held back 4 s), the section says what it is reading");
  await capture("server-loading-desktop-light");
  await visible(section("Who can reach it").getByText(/^Mend checked this server /)).waitFor({
    timeout: 30_000,
  });
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

  // --- The phone: the frames' server, all closed, light and dark ---------------------------
  await page.setViewportSize(PHONE);
  await open("/settings/profile");
  await rewrite({
    "platform.machine": (stack) => withBoat(stack, { key: "fine" }),
    "platform.sealantConnection": () => sealantAnswer(connected),
  });
  await reopen();
  await visible(page.getByRole("button", { name: "Check again" })).waitFor();
  const buttonHeight = await visible(page.getByRole("button", { name: "Check again" })).evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect("a 44px touch target on a phone", buttonHeight >= 44, buttonHeight);
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect("no sideways scroll at 390px", !sideways, sideways);
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`server-private-closed-phone-${theme}`);
  }
  await paint("light");
  await page.unrouteAll({ behavior: "ignoreErrors" });
};
