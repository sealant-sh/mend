// Organization → Access policies in the web app (W4-2, SLNT-1338):
// `/settings/organization/access-policies`, the organization's policies, what Restricted egress
// allows without listing it, the server's private destinations, and durable revocations.
//
//   pnpm verify drive web --recipe access-policies
//
// What is real and what is rewritten:
// - Real: the policies the recipe makes through the page, every refusal the server answers (a
//   wildcard host refused before sending, a name taken, an edit someone else's change made stale),
//   a revocation stored and pushed, and the phone layout.
// - Rewritten in the page: the signed-in read with `role: "member"`, for someone who can only read
//   the page, and a list read that fails, for the error screen and Try again.
//
// A revocation lasts by design: the one this recipe makes names a host on the recipe's own policy
// (`api.example.com`, a host nothing uses), so it reaches no other worktree. The recipe removes its
// policies; the revocation stays, naming a removed policy.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");

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
  const call = (route, input, kind = "query") =>
    page.evaluate(
      async ({ route: name, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of name.split(".")) target = target[part];
        return target[verb](value);
      },
      { route, input, kind },
    );
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await settled();
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
    await capture(name);
  };
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await paint(theme);
      await shot(`${name}-${theme}`);
    }
    await paint("light");
  };
  const text = (words) => visible(page.getByText(words, { exact: true }));
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const dialog = (name) => visible(page.getByRole("dialog", { name }));
  const closed = (name) => page.getByRole("dialog", { name }).waitFor({ state: "hidden" });
  const toastSays = (words) =>
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText(words)
      .first()
      .waitFor({ state: "attached" });
  const policy = (name) => visible(page.getByRole("region", { name, exact: true }));
  const home = "/settings/organization/access-policies";

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  // Policies an earlier run left go first.
  for (const left of (await call("accessPolicies.list")).policies.filter((p) =>
    /^Verify [a-z0-9]{4}( taken)?$/.test(p.name),
  ))
    await call("accessPolicies.remove", { id: left.id }, "mutate").catch(() => undefined);
  const name = `Verify ${Math.random().toString(36).slice(2, 6)}`;
  const made = [];

  try {
    // --- The page as it comes: Standard, built in -------------------------------------------------
    await navigate(home);
    await heading("Access policies");
    await text("Standard").waitFor();
    await visible(policy("Standard").getByText("Built in", { exact: false })).waitFor();
    expect(
      "Standard has no Edit… or Remove…",
      (await policy("Standard").getByRole("button").count()) === 0,
      "",
    );
    await visible(page.getByRole("heading", { name: "Allowed under Restricted egress" })).waitFor();
    await visible(page.getByText("api.anthropic.com", { exact: false })).waitFor();
    note(
      "the page lists Standard as built in with no Edit… or Remove…, and the hosts Restricted egress allows without listing (agent providers, Doppler, MCP servers)",
    );
    await both("access-policies-desktop");

    // --- New policy…: a wildcard refused before sending, then an elevated Restricted policy -------
    await button("New policy…").click();
    const form = dialog("New policy");
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByRole("button", { name: "Restricted egress", exact: true }).click();
    await form.getByLabel("Allowed hosts", { exact: true }).fill("*.example.com");
    await form.getByRole("button", { name: "Add policy", exact: true }).click();
    await visible(form.getByText(/allowHosts/)).waitFor();
    note("a wildcard host is refused in the dialog before anything is sent, naming the rule");
    await shot("access-policies-new-refused-desktop-light");
    await form
      .getByLabel("Allowed hosts", { exact: true })
      .fill("api.example.com\nregistry.example.com:443,5000");
    await form.getByRole("switch", { name: "Brokered secrets" }).click();
    await visible(form.getByText("Elevated.", { exact: false })).waitFor();
    note("turning Brokered secrets on says the policy is elevated before it is saved");
    await both("access-policies-new-elevated-desktop");
    await form.getByRole("button", { name: "Add policy", exact: true }).click();
    await toastSays(`Added ${name}.`);
    await closed("New policy");
    const saved = (await call("accessPolicies.list")).policies.find((p) => p.name === name);
    expect("the new policy is listed", saved !== undefined, name);
    made.push(saved.id);
    expect(
      "it is Restricted, elevated and at revision 1",
      saved.rules.mode === "restricted" && saved.elevated && saved.revision === 1,
      saved,
    );
    await visible(policy(name).getByText("Elevated", { exact: false })).waitFor();
    await visible(policy(name).getByText("registry.example.com:443,5000")).waitFor();
    note(`added ${name}: Restricted egress, two hosts, Brokered secrets, marked Elevated`);
    await both("access-policies-added-desktop");

    // --- A name taken -----------------------------------------------------------------------------
    await button("New policy…").click();
    const again = dialog("New policy");
    await again.getByLabel("Name", { exact: true }).fill(name.toUpperCase());
    await again.getByRole("button", { name: "Add policy", exact: true }).click();
    await visible(again.getByText(/There's already a policy called/)).waitFor();
    note("a name another policy has, in any letter case, is refused in the server's words");
    await shot("access-policies-name-taken-desktop-light");
    await again.getByRole("button", { name: "Cancel", exact: true }).click();
    await closed("New policy");

    // --- An edit someone else's change made stale -------------------------------------------------
    await button(`Edit ${name}`).click();
    const edit = dialog(`Edit ${name}`);
    await edit.getByLabel("Name", { exact: true }).waitFor();
    await call(
      "accessPolicies.update",
      {
        id: saved.id,
        request: { name, rules: saved.rules, expectedRevision: saved.revision },
      },
      "mutate",
    );
    note("meanwhile, the policy was saved again through the API (revision 2)");
    await edit.getByRole("button", { name: "Fetch only", exact: true }).click();
    await edit.getByRole("button", { name: "Save policy", exact: true }).click();
    await visible(edit.getByText(/Someone changed this policy since you opened it/)).waitFor();
    note("the edit sent revision 1 and was refused as stale, the draft kept");
    await shot("access-policies-stale-desktop-light");
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await closed(`Edit ${name}`);
    await button(`Edit ${name}`).click();
    const fresh = dialog(`Edit ${name}`);
    await fresh.getByRole("button", { name: "Fetch only", exact: true }).click();
    await fresh.getByRole("button", { name: "Save policy", exact: true }).click();
    await toastSays(`Saved ${name}.`);
    await closed(`Edit ${name}`);
    await visible(policy(name).getByText("Revision 3", { exact: false })).waitFor();
    note("opened again, the edit saved as revision 3 with Git: Fetch only");

    // --- Revoke access…: the warning first, then each workspace's answer --------------------------
    await button("Revoke access…").click();
    const revoke = dialog("Revoke access");
    await revoke
      .getByLabel("Worktrees", { exact: true })
      .selectOption({ label: `Worktrees on ${name}` });
    await revoke.getByLabel("Host", { exact: true }).fill("api.example.com");
    await visible(revoke.getByText(/A revocation lasts\./)).waitFor();
    note("the dialog says a revocation lasts and wins over every pin before anything is stored");
    await both("access-policies-revoke-desktop");
    await revoke.getByRole("button", { name: "Revoke access", exact: true }).click();
    const revoked = dialog("Revoked");
    await visible(revoked.getByText(/Host api\.example\.com\./)).waitFor();
    note(`revoked: ${(await revoked.innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
    await shot("access-policies-revoked-desktop-light");
    await revoked.getByRole("button", { name: "Done", exact: true }).click();
    await closed("Revoked");
    const list = page.getByRole("list", { name: "Revocations", exact: true });
    await visible(list.getByText("api.example.com")).waitFor();
    await visible(list.getByText(`Worktrees on ${name}`, { exact: false })).waitFor();
    note("the revocation is listed with the policy it reaches and who revoked it");
    await both("access-policies-revocations-desktop");

    // --- Someone who can only read it (the signed-in read rewritten: a member) --------------------
    await page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes("organization.current")) return route.continue();
      const response = await route.fetch();
      const answers = await response.json();
      const listed = Array.isArray(answers) ? answers : [answers];
      for (const [index, path] of paths.entries()) {
        const json = listed[index]?.result?.data?.json;
        if (path === "organization.current" && json?.role !== undefined) json.role = "member";
      }
      await route.fulfill({
        status: response.status(),
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(answers) ? listed : listed[0]),
      });
    });
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(home);
    await heading("Access policies");
    await visible(page.getByText(/Only an owner (of .+ )?can change these/)).waitFor();
    expect(
      "a member sees no New policy…, Edit… or Revoke access…",
      (await page.getByRole("button", { name: /New policy…|Revoke access…|^Edit / }).count()) === 0,
      "",
    );
    note("a member (rewritten read) reads every policy and revocation, with who can change them");
    await shot("access-policies-member-desktop-light");
    await page.unroute("**/trpc/**");
    await clearCache();

    // --- The phone -----------------------------------------------------------------------------------
    await page.setViewportSize(PHONE);
    await open(home);
    await visible(page.getByRole("heading", { name: "Access policies" })).waitFor();
    await both("access-policies-phone");
    await button("New policy…").click();
    await dialog("New policy").getByLabel("Name", { exact: true }).waitFor();
    note("on a phone, New policy… opens as a sheet from the bottom");
    await both("access-policies-new-phone");
    await page.keyboard.press("Escape");
    await page.setViewportSize(DESKTOP);

    // --- A read that fails --------------------------------------------------------------------------
    await open("/settings/profile");
    await page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes("accessPolicies.list")) return route.continue();
      const failure = {
        error: {
          json: {
            message: "The verify recipe failed this read on purpose.",
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          },
        },
      };
      const response = await route.fetch();
      const answers = await response.json();
      const listed = Array.isArray(answers) ? answers : [answers];
      const changed = paths.map((p, index) =>
        p === "accessPolicies.list" ? failure : listed[index],
      );
      await route.fulfill({
        status: paths.length === 1 ? 500 : 207,
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
      });
    });
    await clearCache();
    await navigate(home);
    await heading("This page didn't load");
    note("the list read failing shows the error screen with Try again");
    await shot("access-policies-error-desktop-light");
    await page.unroute("**/trpc/**");
    await button("Try again").click();
    await heading("Access policies");
    note("Try again reads again and the page draws");

    // --- Remove… ------------------------------------------------------------------------------------
    await button(`Remove ${name}`).click();
    const remove = dialog(`Remove ${name}?`);
    await visible(remove.getByText(/keep it/)).waitFor();
    await shot("access-policies-remove-desktop-light");
    await remove.getByRole("button", { name: "Remove policy", exact: true }).click();
    await toastSays(`Removed ${name}.`);
    made.splice(made.indexOf(saved.id), 1);
    note(`removed ${name}: projects that copied it would keep their copies`);
  } finally {
    await page.unroute("**/trpc/**").catch(() => undefined);
    for (const id of made)
      await call("accessPolicies.remove", { id }, "mutate").catch(() => undefined);
  }
};
