// Settings → the organization → Workspace image in the web app (route PR 47, SLNT-1164): the
// starting image Mend copies into each new project when the project is created. Changing it
// changes no existing project (docs/adr/0025, decision 5).
//
//   pnpm verify drive web --recipe settings-workspace-image
//
// Feature ids (workspace-images.md): `image-organization-default` (an owner saves the image, the
// server answers it back, a project made afterwards starts from it, an existing project keeps its
// own), `image-packages` (Add package, remove), `image-rejections` (a package Sealant can't find
// refuses the save and is named), `image-setup-commands` (a custom image's setup commands, saved
// and read back). All of that is the stack's server for real. Recorded answers only for a member's
// view (the role rewritten) and a read that fails. The organization's image is put back at the end,
// and the project the recipe makes is removed.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const PATH = "/settings/organization/workspace-image";
/** A package Sealant's catalog doesn't carry, so the save is refused. */
const UNKNOWN = "verify-no-such-package";

const visible = (locator) => locator.filter({ visible: true }).first();

/** A family image's Current image line on a project's Workspace page: "Arch, zsh and 20 packages." */
const familyLine = (image) =>
  `${image.os[0].toUpperCase()}${image.os.slice(1)}, ${image.shell} and ${image.packages.length} packages.`;

export default async ({ page, web, capture, note }) => {
  const suffix = Date.now().toString(36);
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
  const call = (path, input, kind = "query") =>
    page.evaluate(
      async ({ route, value, verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { route: path, value: input, verb: kind },
    );
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
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const saved = () =>
    page.waitForResponse(
      (response) => response.url().includes("organization.setWorkspaceEnvironment"),
      { timeout: 120_000 },
    );
  const addPackage = async (names) => {
    const field = visible(page.getByLabel("Package to add"));
    if ((await field.count()) === 0 || !(await field.isVisible()))
      await button("Add package").click();
    await visible(page.getByLabel("Package to add")).fill(names);
    await visible(page.getByLabel("Package to add")).press("Enter");
  };
  const reopen = async () => {
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(PATH);
    await heading("Workspace image");
  };

  // tRPC answers this recipe writes, by procedure: `{ error }` or `{ edit }` (changes the server's
  // own answer). Only for the member's view and the failed read.
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, ""))
      .split(",")
      .filter((p) => p !== "");
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    const real = paths.every((p) => stubs.get(p)?.error !== undefined) ? null : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = 200;
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      if (stub.edit !== undefined) {
        const data = answers[index]?.result?.data;
        return data === undefined ? answers[index] : { result: { data: stub.edit(data) } };
      }
      status = paths.length === 1 ? 500 : 207;
      return {
        error: {
          json: {
            message: stub.error,
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          },
        },
      };
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

  // --- What the server holds before the run ------------------------------------------------------
  const original = (await call("organization.settings")).organization.workspaceImage;
  const projectsBefore = await call("projects.list");
  const existing = projectsBefore[0];
  if (existing === undefined) throw new Error("the stack has no project to compare with");
  note(
    `before: the organization's image is ${JSON.stringify(original)}; ${existing.name}'s is ${JSON.stringify(existing.workspaceImage)}`,
  );

  try {
    // --- The page ------------------------------------------------------------------------------
    await navigate(PATH);
    await heading("Workspace image");
    const sidebar = visible(page.getByRole("link", { name: "Workspace image", exact: true }));
    if ((await sidebar.getAttribute("href")) !== PATH)
      throw new Error("the settings sidebar's Workspace image entry doesn't open the page");
    await visible(
      page.getByText(/Mend copies it into each new project when the project is created\./),
    ).waitFor();
    await visible(page.getByText(/Changing it doesn't change existing projects\./)).waitFor();
    note("the page: the frame's words, and the sidebar's entry opens it");
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate("/settings/organization/environment");
    await page.waitForURL((url) => url.pathname === PATH, { timeout: 90_000 });
    await heading("Workspace image");
    note(`the old /settings/organization/environment opens ${new URL(page.url()).pathname}`);
    await shot("image-desktop-light");
    await paint("dark");
    await shot("image-desktop-dark");
    await paint("light");

    // --- A family image: make sure of the mode, then add packages -------------------------------
    if (original.mode !== "family") {
      await visible(page.getByRole("button", { name: "Build from a family" })).click();
    }
    const fresh = ["htop", "less"].filter((name) => !original.packages.includes(name));
    await addPackage(fresh.join(", "));
    for (const name of fresh)
      await visible(page.getByRole("button", { name: `Remove ${name}` })).waitFor();
    await visible(
      page.getByText("Unsaved changes. New projects start from it once you save."),
    ).waitFor();
    note(
      `image-packages: added ${fresh.join(" and ")} with Add package; the Unsaved changes bar shows`,
    );
    await shot("image-unsaved-desktop-light");

    // --- Refused: a package Sealant can't find --------------------------------------------------
    await addPackage(UNKNOWN);
    const refused = saved();
    await button("Save").click();
    await refused;
    const refusal = visible(
      page
        .locator("[role=alert]")
        .filter({ hasText: /^Not saved\. Sealant couldn't find \d+ packages? for / }),
    );
    await refusal.waitFor({ timeout: 60_000 });
    const named = await refusal.locator(".font-mono").allTextContents();
    if (!named.includes(UNKNOWN))
      throw new Error(`the refusal doesn't name ${UNKNOWN}: ${named.join(", ")}`);
    const afterRefusal = (await call("organization.settings")).organization.workspaceImage;
    if (afterRefusal.packages.includes(UNKNOWN)) throw new Error("the refused image was saved");
    note(
      `image-rejections: the save is refused and names ${named.join(", ")} beside why; the server kept the old image`,
    );
    await shot("image-rejected-desktop-light");
    const resolved = fresh.filter((name) => !named.includes(name));
    if (resolved.length === 0)
      throw new Error(`Sealant refused every package added: ${named.join(", ")}`);

    // --- Saved, and read back from the server ---------------------------------------------------
    for (const name of named)
      await visible(page.getByRole("button", { name: `Remove ${name}` })).click();
    const accepted = saved();
    await button("Save").click();
    await accepted;
    await toast(/^Saved\. New projects in .+ start from this image\.$/);
    const now = (await call("organization.settings")).organization.workspaceImage;
    for (const name of resolved)
      if (!now.packages.includes(name)) throw new Error(`${name} isn't in the saved image`);
    await reopen();
    for (const name of resolved)
      await visible(page.getByRole("button", { name: `Remove ${name}` })).waitFor();
    note(
      `image-organization-default: saved; the server answers ${JSON.stringify(now)}, and the page reads it again`,
    );
    await shot("image-saved-desktop-light");

    // --- An existing project kept its own; a new one starts from the new image -----------------
    const kept = (await call("projects.list")).find((project) => project.id === existing.id);
    if (JSON.stringify(kept?.workspaceImage) !== JSON.stringify(existing.workspaceImage))
      throw new Error(`${existing.name}'s image changed: ${JSON.stringify(kept?.workspaceImage)}`);
    const name = `image-check-${suffix}`;
    await call("projects.createNew", { name }, "mutate");
    const made = (await call("projects.list")).find((project) => project.name === name);
    if (made === undefined) throw new Error(`${name} wasn't made`);
    if (JSON.stringify(made.workspaceImage) !== JSON.stringify(now))
      throw new Error(
        `${name} didn't start from the new image: ${JSON.stringify(made.workspaceImage)}`,
      );
    note(
      `a project made after the save (${name}) starts from it: ${JSON.stringify(made.workspaceImage)}; ${existing.name} kept ${JSON.stringify(kept?.workspaceImage)}`,
    );
    // Each project's own Workspace page says the same: the new one the new image, the old one its own.
    await navigate(`/projects/${made.id}/settings/workspace`);
    await visible(page.getByText(familyLine(now), { exact: true })).waitFor();
    note(`${name}'s own Workspace page reads "${familyLine(now)}"`);
    await shot("image-new-project-workspace-desktop-light");
    await navigate(`/projects/${existing.id}/settings/workspace`);
    const existingLine =
      existing.workspaceImage.mode === "family"
        ? familyLine(existing.workspaceImage)
        : `Built from ${existing.workspaceImage.baseImage}, with`;
    await visible(page.getByText(existingLine, { exact: false })).waitFor();
    note(`${existing.name}'s own Workspace page still reads its own image`);
    await shot("image-existing-project-workspace-desktop-light");
    await call("projects.remove", { id: made.id }, "mutate").catch(() => undefined);
    await navigate(PATH);
    await heading("Workspace image");

    // --- A custom image: no base refuses Save; setup commands saved and read back ---------------
    await visible(page.getByRole("button", { name: "Custom image" })).click();
    await visible(page.getByText("Type the base image, such as node:22-bookworm.")).waitFor();
    if (await button("Save").isEnabled()) throw new Error("Save is on with no base image");
    note("a custom image with no base image: Save stays off and says why");
    await visible(page.getByLabel("Base image")).fill("node:22-bookworm");
    await visible(page.getByLabel("Setup commands")).fill("corepack enable\npnpm --version");
    await shot("image-custom-desktop-light");
    const customSaved = saved();
    await button("Save").click();
    const customAnswer = await (await customSaved).json();
    const custom = (await call("organization.settings")).organization.workspaceImage;
    if (custom.mode === "custom") {
      if (custom.setupCommands.join("|") !== "corepack enable|pnpm --version")
        throw new Error(`setup commands read back as ${JSON.stringify(custom.setupCommands)}`);
      note(`image-setup-commands: saved and read back: ${JSON.stringify(custom)}`);
    } else {
      // The stack's runtime may refuse a custom image; then the page said so and nothing saved.
      note(
        `custom image not saved by this stack's server: ${JSON.stringify(customAnswer).slice(0, 300)}`,
      );
    }
    await reopen();
    await shot("image-custom-saved-desktop-light");
  } finally {
    // Put the organization's image back as it was, once the page can call the server again.
    await hydrated();
    await call("organization.setWorkspaceEnvironment", { workspaceImage: original }, "mutate");
    const back = (await call("organization.settings")).organization.workspaceImage;
    note(
      `put back: ${JSON.stringify(back) === JSON.stringify(original) ? "the image as it was" : JSON.stringify(back)}`,
    );
  }

  // --- A member -----------------------------------------------------------------------------------
  stubs.set("organization.current", {
    edit: (data) => ({ ...data, json: { ...data.json, role: "member" } }),
  });
  stubs.set("organization.settings", {
    edit: (data) => ({ ...data, json: { ...data.json, editable: false } }),
  });
  await reopen();
  await visible(page.getByText(/Only an owner can change it: /)).waitFor();
  if ((await page.getByRole("button", { name: "Add package" }).count()) > 0)
    throw new Error("a member can add a package");
  note("a member (role rewritten): the image as rows, no controls, and who can change it");
  await shot("image-member-desktop-light");
  stubs.clear();

  // --- Failed to load, then Try again -------------------------------------------------------------
  stubs.set("organization.settings", { error: "The verify recipe failed this read on purpose." });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate(PATH);
  await heading("This page didn't load");
  note("a settings read that fails shows the error screen with Try again");
  await shot("image-error-desktop-light");
  stubs.clear();
  await button("Try again").click();
  await heading("Workspace image");

  // --- What the runtime can't run (recorded), and a runtime Mend couldn't read ------------------
  stubs.set("organization.runtime", {
    edit: (data) => {
      const reading = data.json.support;
      if (reading.state !== "observed") return data;
      const os = {
        ...reading.support.os,
        arch: { supported: false, message: "This runtime doesn't run Arch workspaces." },
      };
      const support = { ...reading, support: { ...reading.support, os } };
      return { ...data, json: { ...data.json, support } };
    },
  });
  await reopen();
  const refusedOs = visible(page.getByText(/^This runtime doesn't run Arch workspaces\./));
  if (original.mode === "family" && original.os === "arch") {
    await refusedOs.waitFor();
    await addPackage("htop");
    await visible(page.getByText(/can't run this image\.$/)).waitFor();
    if (await button("Save").isEnabled())
      throw new Error("Save is on for an image the runtime refuses");
    if (!(await visible(page.getByRole("button", { name: "Arch", exact: true })).isDisabled()))
      throw new Error("Arch isn't disabled when the runtime refuses it");
    note(
      "an OS the runtime refuses (recorded): Arch disabled, the reason under Operating system in red, Save off and why",
    );
    await shot("image-runtime-refused-desktop-light");
    await button("Discard").click();
  } else {
    note(
      `the organization's image isn't Arch (${original.mode}), so the refused-OS step was left out`,
    );
  }
  stubs.set("organization.runtime", { error: "Sealant didn't answer." });
  await reopen();
  await visible(
    page.getByText(/^Not checked: Mend couldn't read where new sessions in /),
  ).waitFor();
  note(
    "a runtime read that fails (recorded): a Not checked note under Image; every choice stays open",
  );
  await shot("image-runtime-unchecked-desktop-light");
  stubs.clear();

  // --- Phone --------------------------------------------------------------------------------------
  await page.setViewportSize(PHONE);
  await open("/settings/profile");
  await navigate(PATH);
  await visible(page.getByText(/Mend copies it into each new project/)).waitFor();
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-image-${theme}`);
  }
  await paint("light");
  const chip = await visible(page.getByRole("button", { name: "Remove pnpm" })).boundingBox();
  if (chip === null || chip.height < 44)
    throw new Error(`a package's remove button is too small on a phone: ${JSON.stringify(chip)}`);
  await addPackage("htop");
  const bar = visible(page.getByRole("group", { name: "Unsaved changes" }));
  await bar.waitFor();
  const save = await bar.getByRole("button", { name: "Save" }).boundingBox();
  if (save === null || save.height < 44)
    throw new Error(`Save is under 44px on a phone: ${JSON.stringify(save)}`);
  await shot("phone-image-unsaved-light");
  await bar.getByRole("button", { name: "Discard" }).click();
  await bar.waitFor({ state: "hidden" });
  if (
    !original.packages.includes("htop") &&
    (await page.getByRole("button", { name: "Remove htop" }).count()) > 0
  )
    throw new Error("Discard didn't put the saved image back");
  await page.setViewportSize(DESKTOP);
  note(
    "phone: one column, the Unsaved changes bar at the bottom with 44px buttons; Discard put the saved image back",
  );
};
