// Settings → Account → MCP servers in the web app (route PR 41, SLNT-1159): a person's own MCP
// servers (docs/adr/0024) listed, added, edited, turned off and on, removed, a kept sign-in shown
// and forgotten, and the services they reach through their own Executor link, with the sign-in that
// returns through /executor/service-callback.
//
//   pnpm verify drive web --recipe settings-mcp
//
// No feature file covers this page. Its acceptance list is the row's own: add, edit, sign in,
// forget sign-in, remove. A stack has no Executor and no MCP server that signs in, so three things
// come from recorded answers (tRPC answers this recipe writes): a server Mend keeps a sign-in for,
// the Executor link and its services, and Executor's answers to a service sign-in. Every server it
// adds is real, saved on the stack and removed again, so the recipe can run again. A header value
// is one of the verify skill's fakes, typed with typeSecret, and its field is empty in every
// picture.
import { FAKES } from "../scripts/fakes.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
const NAMES = ["linear", "sentry", "filesystem"];
const OBSERVED = "2026-11-19T09:00:00.000Z";

/** A recorded `executor.personal`: an Executor set up, and the person's own link in `state`. */
const link = (state) => ({
  full: true,
  answer: () => ({
    json: { configured: true, url: null, link: { state, observedAt: null } },
  }),
});

/** A recorded `executor.directory`: one service, Sentry, signed in to or not. */
const directory = (linked) => ({
  full: true,
  answer: () => ({
    json: {
      services: [
        {
          id: "svc-sentry",
          name: "Sentry",
          shared: false,
          requirements: [
            {
              name: "oauth",
              scope: "user",
              methods: [{ name: "oauth", label: "OAuth", kind: "oauth", fields: [] }],
              accounts: linked
                ? [{ id: "acc-1", label: "ada@northwind.dev", linked: true, canDisconnect: true }]
                : [],
            },
          ],
        },
      ],
      observedAt: OBSERVED,
    },
    meta: { values: { observedAt: ["Date"] } },
  }),
});

export default async ({ page, web, capture, note, typeSecret }) => {
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
  /** Read the list again, as the page would after a change elsewhere. */
  const reread = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries());
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
  /** Removes this recipe's servers through the page's own client, so a run starts clean. */
  const clean = () =>
    page.evaluate(async (names) => {
      const client = window["__TSR_ROUTER__"].options.context.trpcClient;
      for (const name of names) await client.mcpServers.remove.mutate({ name });
    }, NAMES);
  const row = (name) =>
    visible(
      page
        .locator('[data-slot="setting-row"]')
        .filter({ has: page.getByText(name, { exact: true }) }),
    );
  const toast = (text) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(text)).waitFor();

  // tRPC answers this recipe writes. A stub gets the real answer's `json` and `meta` (or nothing,
  // when every call in the batch is stubbed and `full`) and returns `{ json, meta }` or
  // `{ error }`. One answer per call in a batch; a lone call answers without the array.
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    )
      .split(",")
      .filter((p) => p !== "");
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    const allFull = paths.every((p) => stubs.get(p)?.full === true);
    const response = allFull ? null : await route.fetch();
    const real = response === null ? [] : await response.json();
    const list = Array.isArray(real) ? real : [real];
    let failed = false;
    const answers = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return list[index];
      const data = list[index]?.result?.data;
      const out = stub.answer(data?.json, data?.meta);
      if ("error" in out) {
        failed = true;
        return {
          error: {
            json: {
              message: out.error,
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        };
      }
      return { result: { data: out.meta === undefined ? { json: out.json } : out } };
    });
    const batched =
      response === null
        ? paths.length > 1 || route.request().url().includes("batch=1")
        : Array.isArray(real);
    await route.fulfill({
      status: failed ? (paths.length === 1 ? 500 : 207) : 200,
      contentType: "application/json",
      body: JSON.stringify(batched ? answers : answers[0]),
    });
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  await clean();

  // --- Empty -----------------------------------------------------------------------------------
  await navigate("/settings/mcp-servers");
  await heading("MCP servers");
  await page.getByText("Only you", { exact: true }).first().waitFor();
  const before = await page.locator('[data-slot="setting-row"]').count();
  if (before === 0) {
    await heading("No MCP servers yet");
    note("empty: No MCP servers yet, with Add server…");
    await shot("mcp-empty-desktop-light");
  } else note(`the account already has ${before} servers of its own: the empty state is skipped`);

  // --- Add an HTTP server with a header --------------------------------------------------------
  await visible(page.getByRole("button", { name: "Add server…" })).click();
  await heading("Add MCP server");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("linear");
  await dialog.getByLabel("URL").fill("https://mcp.linear.app/mcp");
  await dialog.getByLabel("Header name").fill("Authorization");
  await shot("mcp-add-dialog-desktop-light");
  await typeSecret(dialog.getByLabel("Value for Authorization"), "mcp-header", FAKES.github);
  await dialog.getByRole("button", { name: "Add server" }).click();
  await toast("Added linear. Your new sessions start with it.");
  await row("linear").waitFor();
  const linearLine = await row("linear").textContent();
  if (!linearLine.includes("Mend sends your sealed Authorization header with each call."))
    throw new Error(`linear's row says ${linearLine}`);
  if (linearLine.includes(FAKES.github)) throw new Error("linear's row shows its header value");
  note("add: linear over HTTP with a sealed Authorization header; the row names it, not its value");
  await shot("mcp-added-desktop-light");

  // --- A name already taken, then a stdio server and an SSE one --------------------------------
  await visible(page.getByRole("button", { name: "Add server…" })).click();
  await dialog.getByLabel("Name", { exact: true }).fill("linear");
  await dialog.getByLabel("URL").fill("https://example.com/mcp");
  await dialog.getByText("You already have linear. Edit it instead.").waitFor();
  note("a taken name is refused before anything is sent");
  await dialog.getByLabel("Name", { exact: true }).fill("filesystem");
  await dialog.getByRole("button", { name: "stdio", exact: true }).click();
  await dialog.getByLabel("Command").fill("npx");
  await dialog
    .getByLabel("Arguments, one per line")
    .fill("-y\n@modelcontextprotocol/server-filesystem\n~/notes");
  await dialog.getByRole("button", { name: "Remove this variable" }).click();
  await dialog.getByRole("button", { name: "Add server" }).click();
  await toast("Added filesystem. Your new sessions start with it.");
  await row("filesystem").getByText("Runs in the session").waitFor();
  await visible(page.getByRole("button", { name: "Add server…" })).click();
  await dialog.getByLabel("Name", { exact: true }).fill("sentry");
  await dialog.getByRole("button", { name: "SSE", exact: true }).click();
  await dialog.getByLabel("URL").fill("https://mcp.sentry.dev/sse");
  await dialog.getByRole("button", { name: "Add server" }).click();
  await toast("Added sentry. Your new sessions start with it.");
  note("add: filesystem (stdio, runs in the session) and sentry (SSE)");

  // --- Turn one off ----------------------------------------------------------------------------
  const filesystemSwitch = row("filesystem").getByRole("switch");
  await filesystemSwitch.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Use filesystem in new sessions"]')
        ?.getAttribute("aria-checked") === "false",
  );
  await reread();
  await settled();
  if ((await filesystemSwitch.getAttribute("aria-checked")) !== "false")
    throw new Error("filesystem is still on after reading the list again");
  note("switch: filesystem turned off, and it stays off when the list is read again");
  await shot("mcp-list-desktop-light");
  await paint("dark");
  await shot("mcp-list-desktop-dark");
  await paint("light");

  // --- A switch that fails ---------------------------------------------------------------------
  stubs.set("mcpServers.save", {
    full: true,
    answer: () => ({ error: "The verify recipe refused this save on purpose." }),
  });
  await row("sentry").getByRole("switch").click();
  await row("sentry").getByText("Mend didn't turn sentry off.").waitFor();
  if ((await row("sentry").getByRole("switch").getAttribute("aria-checked")) !== "true")
    throw new Error("sentry's switch didn't go back after the save failed");
  note("a failed switch goes back and says so under the row, with Try again");
  await shot("mcp-switch-failed-desktop-light");
  stubs.delete("mcpServers.save");
  await row("sentry").getByRole("button", { name: "Try again" }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Use sentry in new sessions"]')
        ?.getAttribute("aria-checked") === "false",
  );
  await row("sentry").getByRole("switch").click();
  note("Try again saves it; sentry is turned on again");

  // --- The menu, and edit ----------------------------------------------------------------------
  await row("linear").getByRole("button", { name: "Actions for linear" }).click();
  await visible(page.getByRole("menuitem", { name: "Edit server…" })).waitFor();
  await shot("mcp-menu-desktop-light");
  await visible(page.getByRole("menuitem", { name: "Edit server…" })).click();
  await heading("Edit linear");
  if ((await dialog.getByLabel("New value for Authorization").inputValue()) !== "")
    throw new Error("the edit dialog filled in a saved header value");
  await shot("mcp-edit-dialog-desktop-light");
  await dialog.getByLabel("URL").fill("https://mcp.linear.app/sse");
  await dialog.getByRole("button", { name: "Save server" }).click();
  await toast("Saved linear. Sessions that start from now on use the new settings.");
  await row("linear")
    .getByText(/https:\/\/mcp\.linear\.app\/sse/)
    .waitFor();
  note("edit: linear's URL changed; its saved header kept (the field stayed empty)");
  await shot("mcp-saved-desktop-light");

  // --- A kept sign-in, from a recorded answer --------------------------------------------------
  stubs.set("mcpServers.list", {
    answer: (json, meta) => {
      const at = json.servers.findIndex((server) => server.name === "linear");
      json.servers[at].signIn = { observedAt: OBSERVED, expiresAt: OBSERVED };
      const values = { ...meta?.values };
      values[`servers.${at}.signIn.observedAt`] = ["Date"];
      values[`servers.${at}.signIn.expiresAt`] = ["Date"];
      return { json, meta: { ...meta, values } };
    },
  });
  await reread();
  await row("linear").getByText("Signed in", { exact: true }).waitFor();
  note("a server Mend keeps a sign-in for says Signed in (recorded answer)");
  await shot("mcp-signed-in-desktop-light");
  await row("linear").getByRole("button", { name: "Actions for linear" }).click();
  await visible(page.getByRole("menuitem", { name: "Forget sign-in…" })).click();
  await heading("Forget your linear sign-in?");
  await shot("mcp-forget-dialog-desktop-light");
  stubs.delete("mcpServers.list");
  await dialog.getByRole("button", { name: "Forget sign-in" }).click();
  await toast("Mend forgot your linear sign-in.");
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('[data-slot="setting-row"]')].some(
        (each) => each.textContent?.startsWith("linear") && each.textContent.includes("Signed in"),
      ),
  );
  note("forget sign-in: confirmed, sent to the server; linear no longer says Signed in");

  // --- Remove ----------------------------------------------------------------------------------
  await row("sentry").getByRole("button", { name: "Actions for sentry" }).click();
  await visible(page.getByRole("menuitem", { name: "Remove server…" })).click();
  await heading("Remove sentry?");
  await shot("mcp-remove-dialog-desktop-light");
  await dialog.getByRole("button", { name: "Remove server" }).click();
  await toast("Removed sentry. New sessions won't get it.");
  if (
    (await page
      .locator('[data-slot="setting-row"]')
      .getByText("sentry", { exact: true })
      .count()) !== 0
  )
    throw new Error("sentry is still listed after Remove");
  note("remove: sentry is gone from the list");
  await shot("mcp-removed-desktop-light");

  // --- Executor services, from recorded answers ------------------------------------------------
  stubs.set("executor.personal", link("unlinked"));
  await reread();
  await heading("Executor services");
  await visible(page.getByRole("link", { name: "Connected apps" })).waitFor();
  note("Executor set up, no link of your own: the section points to Connected apps");
  await shot("mcp-executor-unlinked-desktop-light");
  stubs.set("executor.personal", link("active"));
  stubs.set("executor.directory", directory(false));
  await reread();
  await row("Sentry").getByText("Not signed in.").waitFor();
  note("linked: Executor's services are listed; Sentry is not signed in (recorded answers)");
  await shot("mcp-executor-services-desktop-light");
  await row("Sentry").getByRole("button", { name: "Sign in…" }).click();
  await heading("Sign in to Sentry");
  await shot("mcp-executor-sign-in-desktop-light");
  // Executor answers with its sign-in page; the stand-in sends the browser straight back.
  stubs.set("executor.connectService", {
    full: true,
    answer: () => ({
      json: {
        id: null,
        url: `${web}/executor/service-callback?code=verify-code&state=verify-state`,
        fields: [],
        completed: false,
      },
    }),
  });
  stubs.set("executor.finishService", {
    full: true,
    answer: () => ({ json: { target: "person" } }),
  });
  stubs.set("executor.directory", directory(true));
  const leaving = page.waitForURL((url) => url.pathname === "/executor/service-callback", {
    timeout: 60_000,
  });
  await dialog.getByRole("button", { name: "Open sign-in page" }).click();
  await leaving;
  await page.waitForURL((url) => url.pathname === "/settings/mcp-servers", { timeout: 60_000 });
  await hydrated();
  if (page.url().includes("code=")) throw new Error("the sign-in's code stayed in the address");
  await row("Sentry").getByText("Signed in as ada@northwind.dev.").waitFor();
  note(
    "service sign-in: /executor/service-callback finished it and came back to MCP servers, with no code left in the address",
  );
  await shot("mcp-executor-signed-in-desktop-light");
  // Executor refuses the return.
  stubs.set("executor.finishService", {
    full: true,
    answer: () => ({ error: "Executor didn't accept this sign-in. Start it again." }),
  });
  await page.goto(`${web}/executor/service-callback?code=verify-code&state=verify-state`);
  await heading("The sign-in didn't finish");
  await page.getByText("Executor didn't accept this sign-in. Start it again.").waitFor();
  if (page.url().includes("code="))
    throw new Error("a refused sign-in left its code in the address");
  note("a refused service sign-in says why and links back to MCP servers");
  await shot("mcp-service-callback-refused-desktop-light");
  await visible(page.getByRole("link", { name: "Back to MCP servers" })).click();
  await heading("MCP servers");
  for (const key of [
    "executor.personal",
    "executor.directory",
    "executor.connectService",
    "executor.finishService",
  ])
    stubs.delete(key);

  // --- A failed read ---------------------------------------------------------------------------
  stubs.set("mcpServers.list", {
    full: true,
    answer: () => ({ error: "The verify recipe failed this read on purpose." }),
  });
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/mcp-servers");
  await heading("This page didn't load");
  note("the list's read failing shows the error screen with Try again");
  await shot("mcp-error-desktop-light");
  stubs.delete("mcpServers.list");
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("MCP servers");
  note("Try again reads the list again and the page draws");

  // --- Phone -----------------------------------------------------------------------------------
  await page.setViewportSize(PHONE);
  await open("/settings/mcp-servers");
  await visible(page.getByText("Your servers", { exact: true })).waitFor();
  for (const [label, locator] of [
    ["Add server…", page.getByRole("button", { name: "Add server…" })],
    ["linear's …", page.getByRole("button", { name: "Actions for linear" })],
  ]) {
    const height = (await visible(locator).boundingBox())?.height ?? 0;
    if (height < 44) throw new Error(`${label} is ${height}px tall on a phone, under 44px`);
  }
  note("phone: Add server… and each row's … are 44px touch targets");
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-mcp-${theme}`);
  }
  await paint("light");
  await visible(page.getByRole("button", { name: "Actions for linear" })).click();
  await visible(page.getByRole("menuitem", { name: "Edit server…" })).waitFor();
  await shot("phone-mcp-menu-light");
  await visible(page.getByRole("menuitem", { name: "Edit server…" })).click();
  await heading("Edit linear");
  await shot("phone-mcp-edit-sheet-light");
  await page.keyboard.press("Escape");
  await settled();

  // --- Profile and Appearance still draw their sections (SettingSection changed) ---------------
  await page.setViewportSize(DESKTOP);
  await navigate("/settings/profile");
  await heading("Profile");
  await visible(page.getByRole("heading", { name: "Sign out", exact: true })).waitFor();
  await shot("profile-desktop-light");
  await navigate("/settings/appearance");
  await heading("Appearance");
  await shot("appearance-desktop-light");
  note("Profile and Appearance still draw their section headings and rows");

  // --- Put it back -----------------------------------------------------------------------------
  await clean();
  note("removed the recipe's servers");
};
