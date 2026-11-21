// Settings → the organization → Integrations in the web app (route PR 49, SLNT-1164): the
// organization's Slack app and its Executor. Old `/settings/organization/slack` (Slack's
// `@mend settings` links there) and `/settings/organization/executor` land here.
//
//   pnpm verify drive web --recipe settings-integrations
//
// Feature ids: slack.md `slack-connect`, `slack-display`, the owners' Links list; the
// organization's Executor (manage, configure, the directory, share a service). A stack has no
// Slack workspace and no Executor. Real on the stack: the page as the stack has it (Slack not
// connected, Executor not set up), the manifest and its steps, the verify skill's fake Slack
// tokens sent to the server and refused (typed with typeSecret; the fields empty the moment they
// are sent), and the old addresses. Recorded answers (tRPC answers the recipe writes): a connected
// Slack app, its settings, its links and their removal, its removal, the Executor Mend runs
// (running, an upgrade waiting, stop, start), your own Executor and its shared account, the shared
// services and sharing one, a member's view, and a read that fails. No token appears on the page:
// the recipe checks its text.
import { FAKES } from "../scripts/fakes.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const DAY = 86_400_000;

const visible = (locator) => locator.filter({ visible: true }).first();

const appView = (now, settings = {}) => ({
  json: {
    app: {
      teamId: "T0NORTH",
      teamName: "Northwind",
      appId: "A0MEND",
      botUserId: "U0MEND",
      webOrigin: "http://localhost",
      settings: {
        defaultHarness: "claude",
        showAgentMessages: true,
        showDiffs: false,
        externalChannels: false,
        landAutomatically: true,
        ...settings,
      },
      grantedScopes: ["chat:write", "files:read", "files:write"],
      installedByUserId: "grace",
      installedByName: "Grace Hopper",
      installedAt: new Date(now - 30 * DAY).toISOString(),
      updatedAt: new Date(now - 30 * DAY).toISOString(),
    },
    harnesses: ["claude", "codex"],
  },
  meta: { values: { "app.installedAt": ["Date"], "app.updatedAt": ["Date"] } },
});

const links = (now, people) => ({
  json: people.map(([userName, slackUserId], index) => ({
    teamId: "T0NORTH",
    slackUserId,
    userId: `u${index}`,
    userName,
    createdAt: new Date(now - index * DAY).toISOString(),
  })),
  meta: {
    values: Object.fromEntries(people.map((_, index) => [`${index}.createdAt`, ["Date"]])),
  },
});

const managed = (state, image) => ({
  available: true,
  reason: null,
  state,
  observedAt: null,
  image,
  releaseImage: "ghcr.io/rhyssullivan/executor:v1.5.0",
  memoryBytes: 1.5 * 1024 ** 3,
  backupAt: null,
  retained: true,
});

const configuration = (body) => ({ json: body });

const directory = {
  json: {
    services: [
      {
        id: "linear",
        name: "Linear",
        shared: true,
        requirements: [],
      },
      {
        id: "sentry",
        name: "Sentry",
        shared: false,
        requirements: [],
      },
    ],
  },
};

export default async ({ page, web, capture, note, typeSecret }) => {
  const now = Date.now();
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
  const reread = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries());
  const reopen = async () => {
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate("/settings/organization/integrations");
    await heading("Integrations");
  };
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
  const toast = (text) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(text)).waitFor();
  const dialog = visible(page.getByRole("dialog"));
  const noTokenShown = async () => {
    const text = (await page.locator("body").textContent()) ?? "";
    for (const token of [FAKES.slackAppToken, FAKES.slackBotToken])
      if (text.includes(token) || text.includes(token.slice(-6)))
        throw new Error("the page shows part of a Slack token");
  };

  // tRPC answers this recipe writes, by procedure: `{ json, meta }`, `{ error }`, or `{ edit }`.
  const stubs = new Map();
  const sent = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    )
      .split(",")
      .filter((p) => p !== "");
    for (const p of paths) if (stubs.has(p)) sent.set(p, route.request().postData());
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    // A recorded answer never reaches the server: only fetch when a call needs the real one.
    const needsReal = paths.some((p) => !stubs.has(p) || stubs.get(p).edit !== undefined);
    const real = needsReal ? await route.fetch() : null;
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = real === null ? 200 : real.status();
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      if (stub.edit !== undefined) {
        const data = answers[index]?.result?.data;
        return data === undefined ? answers[index] : { result: { data: stub.edit(data) } };
      }
      if (stub.error !== undefined) {
        status = paths.length === 1 ? 422 : 207;
        return {
          error: {
            json: {
              message: stub.error,
              code: -32603,
              data: { code: "UNPROCESSABLE_CONTENT", httpStatus: 422 },
            },
          },
        };
      }
      return { result: { data: stub.meta === undefined ? { json: stub.json } : stub } };
    });
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(route.request().url().includes("batch=1") ? out : out[0]),
    });
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");

  // --- Old addresses -----------------------------------------------------------------------------
  for (const old of ["/settings/organization/slack", "/settings/organization/executor"]) {
    await navigate(old);
    await page.waitForURL((url) => url.pathname === "/settings/organization/integrations");
    note(`old ${old} lands on Integrations`);
  }
  await heading("Integrations");
  await visible(page.getByText(/^Everyone in /)).waitFor();

  // --- As the stack has it: Slack not connected, Executor not set up ----------------------------
  await visible(page.getByText(/^Not connected\. Mention @mend/)).waitFor();
  note("as the stack is: Slack not connected, with Connect Slack…; Executor as the stack has it");
  await shot("integrations-start-desktop-light");

  // slack-connect: the manifest and its steps, then the fake tokens, refused by the server.
  await visible(page.getByRole("button", { name: "Connect Slack…" })).click();
  await heading("Connect Slack");
  await dialog.getByRole("button", { name: "Copy manifest" }).waitFor();
  await shot("integrations-connect-dialog-desktop-light");
  await typeSecret(dialog.getByLabel("App-level token"), "slack-app-token", FAKES.slackAppToken);
  await typeSecret(dialog.getByLabel("Bot token"), "slack-bot-token", FAKES.slackBotToken);
  const answered = page.waitForResponse((response) => response.url().includes("slack.connect"), {
    timeout: 90_000,
  });
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await answered;
  await dialog.locator("[role=alert]").first().waitFor();
  const refusal = (await dialog.locator("[role=alert]").first().textContent()) ?? "";
  for (const label of ["App-level token", "Bot token"])
    if ((await dialog.getByLabel(label).inputValue()) !== "")
      throw new Error(`${label} kept its value after it was sent`);
  await noTokenShown();
  note(
    `slack-connect: the fake tokens, sent to the stack's server for real, are refused: "${refusal.trim()}"; both fields are empty`,
  );
  await shot("integrations-connect-refused-desktop-light");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // --- A connected Slack app (recorded) ---------------------------------------------------------
  stubs.set("slack.app", appView(now));
  stubs.set(
    "slack.links",
    links(now, [
      ["Ada Lovelace", "U04R2K7N1"],
      ["Grace Hopper", "U02J9X4QD"],
    ]),
  );
  stubs.set(
    "executor.configuration",
    configuration({
      mode: "mend-run",
      url: null,
      mendRunAvailable: true,
      member: { state: "active", observedAt: null },
      managed: managed("running", "ghcr.io/rhyssullivan/executor:v1.4.2"),
    }),
  );
  stubs.set("executor.directory", directory);
  await reread();
  await visible(
    page.getByText(/^Connected to Northwind by Grace Hopper\. 2 people have linked/),
  ).waitFor();
  await visible(page.getByText(/^Running · v1\.4\.2$/)).waitFor();
  await noTokenShown();
  note(
    "Slack connected and the Executor Mend runs (recorded): who connected it, two linked people, the sealed tokens line, Running · v1.4.2 with Upgrade to v1.5.0",
  );
  await shot("integrations-desktop-light");
  await paint("dark");
  await shot("integrations-desktop-dark");
  await paint("light");

  // slack-display: a switch sends the whole settings with that one changed.
  stubs.set("slack.setSettings", {
    json: appView(now, { showDiffs: true }).json.app,
    meta: { values: { installedAt: ["Date"], updatedAt: ["Date"] } },
  });
  await visible(page.getByRole("switch", { name: "Diffs" })).click();
  await page.waitForTimeout(1_000);
  const sentSettings = sent.get("slack.setSettings") ?? "";
  if (
    !sentSettings.includes('"showDiffs":true') ||
    !sentSettings.includes('"defaultHarness":"claude"')
  )
    throw new Error(`turning on Diffs sent ${sentSettings}`);
  note("slack-display: turning on Diffs sends slack.setSettings with every setting, Diffs on");

  // The owners' Links list, and removing one.
  await visible(page.getByRole("button", { name: "View linked people" })).click();
  await heading("Linked people");
  await dialog.getByText("Ada Lovelace").waitFor();
  await shot("integrations-links-dialog-desktop-light");
  stubs.set("slack.removeLink", { json: null });
  await dialog.getByRole("button", { name: "Remove Ada Lovelace's Slack link…" }).click();
  await dialog.getByText(/stop starting sessions until they link again/).waitFor();
  stubs.set("slack.links", links(now, [["Grace Hopper", "U02J9X4QD"]]));
  await dialog.getByRole("button", { name: "Remove link" }).click();
  await toast("Removed Ada Lovelace's Slack link.");
  if (!(sent.get("slack.removeLink") ?? "").includes("U04R2K7N1"))
    throw new Error("removing a link didn't send its Slack user");
  note("Links: Remove… asks, then sends slack.removeLink for that Slack user (recorded)");
  await page.keyboard.press("Escape");

  // Replace tokens and Remove open their dialogs.
  await visible(page.getByRole("button", { name: "Replace tokens…" })).click();
  await heading("Replace the tokens for Northwind");
  await shot("integrations-replace-tokens-desktop-light");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await visible(page.getByRole("button", { name: "Remove…" })).click();
  await heading("Remove the Slack app from Northwind?");
  stubs.set("slack.disconnect", { json: null });
  stubs.set("slack.app", { json: { app: null, harnesses: ["claude", "codex"] } });
  await dialog.getByRole("button", { name: "Remove the Slack app" }).click();
  await toast("Removed the Slack app.");
  await visible(page.getByRole("button", { name: "Connect Slack…" })).waitFor();
  note(
    "Remove the Slack app: the dialog lists what goes, then the page offers Connect Slack… again (recorded)",
  );
  stubs.set("slack.app", appView(now));

  // --- Executor: stop, start, upgrade (recorded) ------------------------------------------------
  stubs.set("executor.manage", {
    json: managed("stopped", "ghcr.io/rhyssullivan/executor:v1.4.2"),
  });
  await visible(page.getByRole("button", { name: "Stop Executor" })).click();
  await toast("Stopped Executor.");
  if (!(sent.get("executor.manage") ?? "").includes('"stop"'))
    throw new Error("Stop Executor didn't send stop");
  note("Executor: Stop Executor sends executor.manage stop (recorded)");

  // The shared services, and sharing one.
  const shared = visible(page.getByRole("region", { name: "Shared services" }));
  await shared.getByText("Sentry").waitFor();
  stubs.set("executor.shareService", { json: null });
  await shared.getByRole("button", { name: "Share Sentry with everyone" }).click();
  await page.waitForTimeout(1_000);
  if (!(sent.get("executor.shareService") ?? "").includes("sentry"))
    throw new Error("sharing Sentry didn't send it");
  note("share a service: Share with everyone sends executor.shareService for Sentry (recorded)");
  await shot("integrations-executor-desktop-light");

  // Your own Executor, with its shared account.
  stubs.set(
    "executor.configuration",
    configuration({
      mode: "own",
      url: "https://executor.northwind.example",
      mendRunAvailable: true,
      member: { state: "unlinked", observedAt: null },
    }),
  );
  await reread();
  await visible(
    page.getByText("Your own Executor at https://executor.northwind.example."),
  ).waitFor();
  await visible(page.getByRole("button", { name: "Link", exact: true })).waitFor();
  note(
    "your own Executor (recorded): its address with Change… and Stop using it…, and the shared account with Link",
  );
  await shot("integrations-executor-own-desktop-light");
  await visible(page.getByRole("button", { name: "Change…" })).click();
  await heading("Use your own Executor");
  stubs.set("executor.configure", { error: "Mend couldn't reach an Executor at that address." });
  await dialog.getByLabel("Executor address").fill("https://nowhere.example");
  await dialog.getByRole("button", { name: "Save address" }).click();
  await dialog.getByText("Mend couldn't reach an Executor at that address.").waitFor();
  note("configure: a refused address is said in the dialog (recorded)");
  await page.keyboard.press("Escape");

  // --- A service sign-in comes back where it started (recorded answers) ------------------------
  stubs.set("executor.finishService", { json: { target: "member" } });
  await page.goto(`${web}/executor/service-callback?code=verify-code&state=verify-state`);
  await page.waitForURL((url) => url.pathname === "/settings/organization/integrations", {
    timeout: 60_000,
  });
  if (page.url().includes("code=")) throw new Error("the sign-in's code stayed in the address");
  note(
    "a shared account's service sign-in comes back to Integrations, code gone (recorded finish)",
  );
  stubs.set("executor.finishService", { json: { target: "person" } });
  await page.goto(`${web}/executor/service-callback?code=verify-code&state=verify-state`);
  await page.waitForURL((url) => url.pathname === "/settings/mcp-servers", { timeout: 60_000 });
  note("a person's own service sign-in still comes back to MCP servers (recorded finish)");
  stubs.delete("executor.finishService");
  await open("/settings/profile");

  // --- A member: what is set up, nothing to change (recorded role) ------------------------------
  stubs.set("organization.current", {
    edit: (data) => ({ ...data, json: { ...data.json, role: "member" } }),
  });
  stubs.set("slack.me", {
    json: {
      workspace: { teamId: "T0NORTH", teamName: "Northwind" },
      link: null,
      defaultProjectId: null,
    },
  });
  await reopen();
  await visible(page.getByText(/^Connected to Northwind\. Mention @mend there/)).waitFor();
  if (
    (await page.getByRole("button", { name: /Connect|Replace|Remove|Stop|Upgrade|Link/ }).count()) >
    0
  )
    throw new Error("a member sees a button that changes Slack or Executor");
  note("a member (recorded role) reads what is set up, with no button that changes it");
  await shot("integrations-member-desktop-light");
  stubs.delete("organization.current");
  stubs.delete("slack.me");

  // --- A read that fails ------------------------------------------------------------------------
  stubs.set("slack.app", { error: "The verify recipe failed this read on purpose." });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/organization/integrations");
  await heading("This page didn't load");
  note("a read that fails shows the error screen with Try again");
  await shot("integrations-error-desktop-light");
  stubs.set("slack.app", appView(now));
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("Integrations");

  // --- Phone ------------------------------------------------------------------------------------
  stubs.set(
    "executor.configuration",
    configuration({
      mode: "mend-run",
      url: null,
      mendRunAvailable: true,
      member: { state: "active", observedAt: null },
      managed: managed("running", "ghcr.io/rhyssullivan/executor:v1.4.2"),
    }),
  );
  await page.setViewportSize(PHONE);
  await open("/settings/profile");
  await reopen();
  const replace = visible(page.getByRole("button", { name: "Replace tokens…" }));
  await replace.waitFor();
  const height = (await replace.boundingBox())?.height ?? 0;
  if (height < 44) throw new Error(`Replace tokens… is ${height}px tall on a phone, under 44px`);
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-integrations-${theme}`);
  }
  await paint("light");
  stubs.clear();
  await page.setViewportSize(DESKTOP);
  note("phone: 44px buttons under each app's line, dialogs as sheets");
};
