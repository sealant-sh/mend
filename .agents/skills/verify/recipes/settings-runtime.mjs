// Settings → the organization → Runtime in the web app (route PR 47, SLNT-1164): where the
// organization's new sessions run (Docker or Boat), and what a switch would change, said before it
// happens. A switch stops no running session: what the server answers first (`runtimeSwitch`) is
// what the new runtime wouldn't run, and the moves Mend offers in the same step.
//
//   pnpm verify drive web --recipe settings-runtime
//
// A stack offers no Boat runtime. What it does for real: the page as the stack has it, and the old
// addresses (`/settings/organization/defaults`, `/settings#organization-defaults`,
// `/settings/organization/environment`). Everything else comes from recorded answers (tRPC answers
// the recipe writes): a server that offers Docker and Boat, a switch that changes nothing, a switch
// that would leave projects unable to start new sessions (cancelled, refused, switched without
// moving, then moved), a switch Mend couldn't check, a member's view, a server where Sealant picks,
// and a read that fails.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const PATH = "/settings/organization/runtime";

const visible = (locator) => locator.filter({ visible: true }).first();

const arch = {
  mode: "family",
  os: "arch",
  packages: ["ripgrep", "jq", "postgresql"],
  shell: "bash",
  services: { docker: false },
  screen: false,
};
const ubuntu = { ...arch, os: "ubuntu", packages: [] };

/** Where new sessions run on a server that offers Docker and Boat, Docker by default. */
const both = (runtime) => ({
  chosen: runtime,
  effective: runtime,
  offered: ["docker", "boat"],
  serverDefault: "docker",
});

/** A recorded `runtimeSwitch` answer. */
const switchView = (runtime, impact) => ({
  json: { chosen: runtime, effective: runtime, impact },
  meta: impact.observedAt === undefined ? undefined : { values: { "impact.observedAt": ["Date"] } },
});

const nothing = (runtime) =>
  switchView(runtime, {
    state: "observed",
    observedAt: new Date().toISOString(),
    runtime,
    organizationDefault: null,
    projects: [],
    unseen: 0,
  });

/** Boat can't run Arch: the organization's image, one project to move, one with a held port. */
const boatRefuses = (org) =>
  switchView("boat", {
    state: "observed",
    observedAt: new Date().toISOString(),
    runtime: "boat",
    organizationDefault: {
      refusal: "Boat runs Ubuntu and Nix workspaces only.",
      from: arch,
      to: ubuntu,
      inherited: false,
    },
    projects: [
      {
        id: "project-checkout",
        name: "checkout-api",
        environment: {
          refusal: "Boat runs Ubuntu and Nix workspaces only.",
          from: arch,
          to: ubuntu,
          inherited: false,
        },
        services: [],
        serverFolders: null,
      },
      {
        id: "project-billing",
        name: `${org.toLowerCase()}-billing`,
        environment: null,
        services: [{ name: "ssh-tunnel", port: 22 }],
        serverFolders: null,
      },
    ],
    unseen: 1,
  });

export default async ({ page, web, capture, note }) => {
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
  const path = () => new URL(page.url()).pathname;
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
  const dialog = visible(page.getByRole("dialog", { name: /^Before new sessions run on / }));
  /** Waits for the next answer to a switch, so a check reads what that click sent. */
  const switched = () =>
    page.waitForResponse((response) => response.url().includes("organization.setSessionRuntime"), {
      timeout: 90_000,
    });
  const radio = (name) => visible(page.getByRole("radio", { name, exact: true }));
  const reopen = async () => {
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(PATH);
    await heading("Runtime");
  };

  // tRPC answers this recipe writes, by procedure: `{ json, meta }`, `{ error, tag }`, `{ edit }`
  // (changes the server's own answer), or `{ pick }` (chooses one of those by the call's input).
  const stubs = new Map();
  const sent = [];
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, ""))
      .split(",")
      .filter((p) => p !== "");
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    // The app sends queries as POST too (`methodOverride`), so a call's input is in the body.
    const body = route.request().postData();
    const inputs = JSON.parse(body ?? url.searchParams.get("input") ?? "{}");
    // What each switch sent; queries are POSTs too, so only the switch is kept.
    for (const p of paths)
      if (p === "organization.setSessionRuntime" && body !== null) sent.push({ path: p, body });
    const resolve = (p, index) => {
      const stub = stubs.get(p);
      const input = (url.searchParams.get("batch") === "1" ? inputs[index] : inputs)?.json;
      return stub?.pick === undefined ? stub : stub.pick(input);
    };
    const real = paths.every((p, i) => stubs.has(p) && resolve(p, i).edit === undefined)
      ? null
      : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = 200;
    const out = paths.map((p, index) => {
      const stub = stubs.has(p) ? resolve(p, index) : undefined;
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
              data: { code: "UNPROCESSABLE_CONTENT", httpStatus: 422, tag: stub.tag ?? null },
            },
          },
        };
      }
      return { result: { data: stub.meta === undefined ? { json: stub.json } : stub } };
    });
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(url.searchParams.get("batch") === "1" ? out : out[0]),
    });
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");

  // --- As the stack has it ----------------------------------------------------------------------
  // The server's real settings, kept so recorded answers are built from them.
  let real = null;
  stubs.set("organization.settings", {
    edit: (data) => {
      real = data;
      return data;
    },
  });
  await navigate(PATH);
  await heading("Runtime");
  const org = await orgName(page);
  const sidebar = visible(page.getByRole("link", { name: "Runtime", exact: true }));
  if ((await sidebar.getAttribute("href")) !== PATH)
    throw new Error("the settings sidebar's Runtime entry doesn't open the page");
  await visible(page.getByText(`Where ${org}'s new sessions run.`, { exact: false })).waitFor();
  const runtimes = real?.json?.sessionRuntime;
  note(
    `as the stack is: offered ${JSON.stringify(runtimes?.offered)}, server default ${runtimes?.serverDefault}, chosen ${runtimes?.chosen}; the sidebar's Runtime entry opens the page`,
  );
  await shot("runtime-stack-desktop-light");

  // --- Old addresses ----------------------------------------------------------------------------
  for (const [old, now] of [
    ["/settings/organization/defaults", PATH],
    ["/settings#organization-defaults", PATH],
    ["/settings/organization/environment", "/settings/organization/workspace-image"],
    ["/settings#organization-environment", "/settings/organization/workspace-image"],
  ]) {
    await page.goto(`${web}${old}`);
    await page.waitForURL((url) => url.pathname === now, { timeout: 90_000 });
    note(`${old} → ${path()}`);
  }
  await open("/settings/profile");

  // --- A server that offers Docker and Boat, new sessions on Boat (recorded) ---------------------
  const offering = (sessionRuntime, editable = true) => ({
    edit: (data) => {
      real = data;
      return { ...data, json: { ...data.json, editable, sessionRuntime } };
    },
  });
  const saved = (runtime) => ({
    json: { ...real.json, editable: true, sessionRuntime: both(runtime) },
  });
  stubs.set("organization.settings", offering(both("boat")));
  stubs.set("organization.runtimeSwitch", { pick: (input) => nothing(input?.sessionRuntime) });
  await reopen();
  await radio("Boat").waitFor();
  if (!(await radio("Boat").isChecked())) throw new Error("Boat isn't selected");
  const boatKey = visible(page.getByRole("link", { name: "Boat key", exact: true }));
  if ((await boatKey.getAttribute("href")) !== "/settings/organization/boat")
    throw new Error("Boat key doesn't link to the Boat page");
  note("offered Docker and Boat (recorded): Boat selected, its line links to the Boat page");
  await shot("runtime-desktop-light");
  await paint("dark");
  await shot("runtime-desktop-dark");
  await paint("light");

  // A switch the server says changes nothing: no dialog, saved at once.
  stubs.set("organization.setSessionRuntime", saved("docker"));
  const toDocker = switched();
  await radio("Docker").click();
  await toDocker;
  await toast(`New sessions in ${org} run on Docker.`);
  if (!sent.some((s) => s.path === "organization.setSessionRuntime" && s.body.includes('"docker"')))
    throw new Error("the switch to Docker wasn't sent");
  if (await dialog.isVisible()) throw new Error("a switch that changes nothing asked first");
  stubs.set("organization.settings", offering(both("docker")));
  await reopen();
  if (!(await radio("Docker").isChecked())) throw new Error("Docker isn't selected after a reload");
  note(
    "switch to Docker: the server says nothing changes, so it switches without a dialog; toast; Docker selected when the page is read again",
  );

  // A switch that would leave projects unable to start new sessions: asked first.
  stubs.set("organization.runtimeSwitch", {
    pick: (input) => (input?.sessionRuntime === "boat" ? boatRefuses(org) : nothing("docker")),
  });
  const before = sent.length;
  await radio("Boat").click();
  await dialog.waitFor();
  await dialog
    .getByText(`What Boat wouldn't run: 3 projects and ${org}'s workspace image`)
    .waitFor();
  await dialog.getByText("checkout-api", { exact: true }).waitFor();
  await dialog.getByText("1 private project", { exact: true }).waitFor();
  await dialog.getByText(/Running sessions stay where they are/).waitFor();
  note(
    "switch to Boat (recorded answer): the dialog says what Boat wouldn't run — 3 projects and the workspace image, each with Sealant's reason — and that running sessions stay",
  );
  await shot("runtime-switch-dialog-desktop-light");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  if (sent.length !== before) throw new Error("Cancel sent something");
  if (!(await radio("Docker").isChecked())) throw new Error("Cancel didn't leave Docker selected");
  note("Cancel: nothing sent, Docker still selected");

  // Refused, then switched without moving.
  await radio("Boat").click();
  await dialog.waitFor();
  stubs.set("organization.setSessionRuntime", {
    error:
      "This server does not offer Boat for sessions. It offers Docker; its operator changes that with mend server setup --session-runtimes.",
  });
  await dialog.getByRole("button", { name: "Switch without moving" }).click();
  await dialog.getByText(/^Not switched\. This server does not offer Boat/).waitFor();
  note("refused (recorded): the server's words in the dialog, which stays open");
  await shot("runtime-switch-refused-desktop-light");
  stubs.set("organization.setSessionRuntime", saved("boat"));
  stubs.set("organization.settings", offering(both("boat")));
  stubs.set("organization.runtimeSwitch", { pick: () => boatRefuses(org) });
  const withoutMoving = switched();
  await dialog.getByRole("button", { name: "Switch without moving" }).click();
  await withoutMoving;
  await toast(`New sessions in ${org} run on Boat.`);
  const last = sent.at(-1);
  if (last?.path !== "organization.setSessionRuntime" || last.body.includes("moves"))
    throw new Error("Switch without moving sent moves");

  // What Boat doesn't run stays on the page, with the move.
  await visible(
    page.getByText(`What Boat doesn't run: 3 projects and ${org}'s workspace image`),
  ).waitFor();
  note(
    "switched without moving: the page now lists what Boat doesn't run, with Move to what Boat runs",
  );
  await shot("runtime-standing-desktop-light");
  stubs.set("organization.setSessionRuntime", saved("boat"));
  const moved = switched();
  await visible(page.getByRole("button", { name: "Move to what Boat runs" })).click();
  await moved;
  await toast(`Moved. New sessions in ${org} run on Boat.`);
  const move = sent.at(-1);
  if (!move?.body.includes("project-checkout") || !move.body.includes('"organizationDefault":true'))
    throw new Error("the move didn't send the organization's image and checkout-api");
  note("Move to what Boat runs: sends the organization's image and checkout-api; toast says Moved");

  // Move and switch, from the dialog.
  stubs.set("organization.settings", offering(both("docker")));
  stubs.set("organization.runtimeSwitch", {
    pick: (input) => (input?.sessionRuntime === "boat" ? boatRefuses(org) : nothing("docker")),
  });
  await reopen();
  stubs.set("organization.setSessionRuntime", saved("boat"));
  await radio("Boat").click();
  await dialog.waitFor();
  const moveAndSwitch = switched();
  await dialog.getByRole("button", { name: "Move and switch" }).click();
  await moveAndSwitch;
  await toast(`Moved. New sessions in ${org} run on Boat.`);
  const both2 = sent.at(-1);
  if (!both2?.body.includes('"boat"') || !both2.body.includes("project-checkout"))
    throw new Error("Move and switch didn't send the runtime with the moves");
  note("Move and switch: sends Boat with the moves in one request");

  // A switch Mend couldn't check.
  stubs.set("organization.settings", offering(both("boat")));
  stubs.set("organization.runtimeSwitch", {
    pick: (input) =>
      input?.sessionRuntime === "docker"
        ? switchView("docker", { state: "unread", reason: "Sealant didn't answer in 10 s" })
        : nothing("boat"),
  });
  await reopen();
  await radio("Docker").click();
  await dialog.waitFor();
  await dialog.getByText(/^Not checked: Mend couldn't read what Docker runs/).waitFor();
  await dialog.getByRole("button", { name: "Switch to Docker anyway" }).waitFor();
  note(
    "not checked (recorded): the dialog says Mend couldn't read it and offers Switch to Docker anyway",
  );
  await shot("runtime-switch-unchecked-desktop-light");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  // --- A member ---------------------------------------------------------------------------------
  stubs.set("organization.settings", offering(both("boat"), false));
  stubs.set("organization.current", {
    edit: (data) => ({ ...data, json: { ...data.json, role: "member" } }),
  });
  await reopen();
  await visible(page.getByText(/Only an owner can change this: /)).waitFor();
  if (!(await radio("Boat").isDisabled())) throw new Error("a member can pick a runtime");
  note("a member (role rewritten): the choices read only, and the intro names who can change it");
  await shot("runtime-member-desktop-light");
  stubs.delete("organization.current");

  // --- Sealant picks ----------------------------------------------------------------------------
  stubs.set(
    "organization.settings",
    offering({ chosen: null, effective: null, offered: [], serverDefault: null }),
  );
  await reopen();
  await visible(page.getByText("Sealant picks", { exact: true })).waitFor();
  if ((await page.getByRole("radio").count()) > 0) throw new Error("radios where Sealant picks");
  note("a server where Sealant picks (recorded): no choice, and how an operator offers runtimes");
  await shot("runtime-sealant-picks-desktop-light");

  // --- Failed to load, then Try again -----------------------------------------------------------
  stubs.set("organization.settings", { error: "The verify recipe failed this read on purpose." });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate(PATH);
  await heading("This page didn't load");
  note("a settings read that fails shows the error screen with Try again");
  await shot("runtime-error-desktop-light");
  stubs.set("organization.settings", offering(both("boat")));
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("Runtime");

  // --- Phone ------------------------------------------------------------------------------------
  // Recorded answers don't reach the server's own render: load a page, then move through the router.
  await page.setViewportSize(PHONE);
  stubs.set("organization.runtimeSwitch", {
    pick: (input) => (input?.sessionRuntime === "boat" ? nothing("boat") : boatRefuses(org)),
  });
  stubs.set("organization.settings", offering(both("boat")));
  await open("/settings/profile");
  await clearCache();
  await navigate(PATH);
  await radio("Boat").waitFor();
  const row = await radio("Docker").evaluate(
    (el) => el.parentElement.getBoundingClientRect().height,
  );
  if (row < 44) throw new Error(`the Docker row is ${row}px tall on a phone, under 44px`);
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-runtime-${theme}`);
  }
  await paint("light");
  stubs.set("organization.runtimeSwitch", {
    pick: (input) => (input?.sessionRuntime === "boat" ? boatRefuses(org) : nothing("docker")),
  });
  stubs.set("organization.settings", offering(both("docker")));
  await reopen();
  await radio("Boat").click();
  await visible(page.getByText("Before new sessions run on Boat", { exact: true })).waitFor();
  const moveButton = visible(page.getByRole("button", { name: "Move and switch" }));
  const box = await moveButton.boundingBox();
  if (box === null || box.x < 0 || box.x + box.width > PHONE.width || box.height < 44)
    throw new Error(
      `Move and switch doesn't fit the phone's width at 44px: ${JSON.stringify(box)}`,
    );
  await shot("phone-runtime-switch-sheet-light");
  await page.keyboard.press("Escape");
  stubs.clear();
  await page.setViewportSize(DESKTOP);
  note("phone: rows at least 44px, the switch's dialog as a sheet");
};

/** The organization's name, from the audience line ("Everyone in Northwind"). */
async function orgName(page) {
  const line = await page
    .getByText(/^Everyone in /)
    .filter({ visible: true })
    .first()
    .textContent();
  return (line ?? "").replace(/^Everyone in /, "").trim();
}
