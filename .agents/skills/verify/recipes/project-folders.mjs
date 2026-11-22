// A project's Folders and references page in the web app (route PR 56, SLNT-1171):
// `/projects/<id>/settings/folders`, and the Linked projects section it adds to the project's
// General page.
//
//   pnpm verify drive web --recipe project-folders
//
// Feature ids: references-folders.md `folder-select` (Off, Read only, Read and write per folder),
// `ref-select` (a reference on or off for the project's sessions), `host-mounts` (an operator of a
// single install adds and removes a server folder), `link-project` (on General: link a project,
// with its directory name, and unlink it). `ref-add` moved to the organization's page by
// docs/adr/0025 (the organization keeps its references; a project only picks them): this page
// links there.
//
// What is real and what is rewritten:
// - Real: two projects the recipe creates (no repository); two organization folders it makes, one
//   with two files; a reference cloned from GitHub; each folder's access and the reference's switch
//   saved and read back from the server and after a reload; a server folder added and removed as
//   the stack's first account (its operator) or, on a server running several organizations, where
//   no one is offered them, the section's absence and the server refusing one; a project linked and
//   unlinked on General.
// - Rewritten: a save the server refuses (the folder goes back, with the sentence), the page as
//   someone who may only read it (`capabilities.manage` false: who can change it, no controls), an
//   organization with no folders or references, and a read that fails (a 500), for the error screen
//   and Try again.
//
// The recipe removes everything it made, so it can run again.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const REFERENCE_URL = "https://github.com/octocat/Hello-World";

const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${String(JSON.stringify(seen)).slice(0, 400)}`);
};
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");
/** Base64 of a short ASCII text, for a folder upload. */
const base64 = (text) => Buffer.from(text, "utf8").toString("base64");

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
  /** A tRPC call from the page, as the signed-in person. */
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
  const text = (words) => visible(page.getByText(words, { exact: true }));
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const toastSays = (words) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(words)).waitFor();
  const access = (folder, words) =>
    visible(
      page
        .getByRole("group", { name: `Access to ${folder}`, exact: true })
        .getByRole("button", { name: words, exact: true }),
    );
  const pressed = async (folder, words) =>
    (await access(folder, words).getAttribute("aria-pressed")) === "true";
  /** Wait for every toast to leave, so a capture shows the page under it. */
  const noToasts = () =>
    page
      .waitForFunction(
        () =>
          document.querySelectorAll('[aria-label^="Notifications"] [role="dialog"]').length === 0,
        null,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
  const waitFor = async (what, check) => {
    for (let tries = 0; tries < 40; tries += 1) {
      if (await check()) return;
      await page.waitForTimeout(250);
    }
    throw new Error(`${what} never happened`);
  };

  // tRPC answers this recipe writes, by procedure: `{ json }` or `{ error }`; a function of the
  // real answer rewrites it.
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = pathsOf(route.request());
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    const real = paths.every((p) => stubs.has(p) && typeof stubs.get(p) !== "function")
      ? null
      : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = 200;
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      if (typeof stub === "function") return stub(answers[index]);
      if (stub.error !== undefined) {
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
      }
      return { result: { data: { json: stub.json } } };
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
  const me = await page.evaluate(async () => (await fetch("/api/organization")).json());
  expect("the owner's organization", me?.role === "owner", me);
  const organization = me.organization.name;

  // What an earlier run left when it stopped partway goes first.
  const LEFT = /^pf-[a-z0-9]{4}/;
  for (const left of (await call("projects.list")).filter((entry) => LEFT.test(entry.name))) {
    for (const link of await call("projects.links", { id: left.id }).catch(() => []))
      await call("projects.removeLink", { id: left.id, linkId: link.id }, "mutate").catch(
        () => undefined,
      );
    await call("projects.setFolders", { id: left.id, selections: [] }, "mutate").catch(
      () => undefined,
    );
    await call("projects.remove", { id: left.id }, "mutate").catch(() => undefined);
  }
  for (const left of (await call("projects.removed")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.purge", { id: left.id, confirm: left.name }, "mutate").catch(
      () => undefined,
    );
  for (const left of (await call("folders.list")).filter((entry) => LEFT.test(entry.name)))
    await call("folders.remove", { id: left.id }, "mutate").catch(() => undefined);
  for (const left of (await call("git.references")).filter((entry) => LEFT.test(entry.name)))
    await call("git.removeReference", { id: left.id }, "mutate").catch(() => undefined);

  const stamp = Math.random().toString(36).slice(2, 6);
  const name = `pf-${stamp}-api`;
  const project = await call("projects.createNew", { name }, "mutate");
  const sibling = await call("projects.createNew", { name: `pf-${stamp}-web` }, "mutate");
  const runbooks = await call("folders.create", { name: `pf-${stamp}-runbooks` }, "mutate");
  const tokens = await call("folders.create", { name: `pf-${stamp}-tokens` }, "mutate");
  await call(
    "folders.upload",
    {
      id: runbooks.id,
      merge: true,
      files: [
        {
          path: "deploy.md",
          contentsBase64: base64("# Deploy\n\nRun the checks first.\n"),
        },
        { path: "rollback.md", contentsBase64: base64("# Roll back\n") },
      ],
    },
    "mutate",
  );
  const reference = await call(
    "git.addReference",
    { name: `pf-${stamp}-hello`, source: REFERENCE_URL, ref: null },
    "mutate",
  );
  note(
    `made ${name} and ${sibling.name}, folders ${runbooks.name} (2 files) and ${tokens.name} (empty), and the reference ${reference.name}, a real clone of ${REFERENCE_URL}`,
  );
  const page56 = `/projects/${project.id}/settings/folders`;
  let mountId = null;

  try {
    // --- The page, as the person who added the project, from the settings sidebar ---------------
    await open(`/projects/${project.id}/settings/general`);
    await heading("General");
    const sidebar = page.locator('[data-slot="sidebar"][aria-label="Settings"]');
    await visible(
      sidebar
        .getByRole("list", { name })
        .getByRole("link", { name: "Folders and references", exact: true }),
    ).click();
    await page.waitForURL((url) => url.pathname === page56);
    await heading("Folders and references");
    note(`the settings sidebar's ${name} → Folders and references opens ${page56}`);
    await text(`Everyone who can open ${name}`).waitFor();
    await heading(`${organization} folders`);
    await heading("References");
    const row = (label) => visible(page.getByRole("row", { name: label }));
    await visible(row(runbooks.name).getByText(/^2 files · /)).waitFor();
    await visible(row(tokens.name).getByText("Empty", { exact: true })).waitFor();
    expect("every folder starts Off", await pressed(runbooks.name, "Off"), runbooks.name);
    const orgLink = visible(
      page.getByRole("link", {
        name: `${organization}'s Folders and references page`,
      }),
    );
    note(
      `${page56}: folders with their size, the reference with its version; the organization's page is linked (${await orgLink.getAttribute("href")})`,
    );

    // --- folder-select ------------------------------------------------------------------------
    await access(runbooks.name, "Read only").click();
    await access(tokens.name, "Read and write").click();
    await waitFor("the server holds both folders", async () => {
      const picked = await call("projects.folders", { id: project.id });
      return (
        picked.some((entry) => entry.folder.id === runbooks.id && entry.readOnly) &&
        picked.some((entry) => entry.folder.id === tokens.id && !entry.readOnly)
      );
    });
    note(`folder-select: ${runbooks.name} Read only and ${tokens.name} Read and write, saved`);

    // --- ref-select ---------------------------------------------------------------------------
    const refSwitch = visible(
      page.getByRole("switch", { name: `Use ${reference.name} in sessions` }),
    );
    await refSwitch.click();
    await waitFor("the server holds the reference", async () =>
      (await call("projects.references", { id: project.id })).some(
        (entry) => entry.id === reference.id,
      ),
    );
    note(`ref-select: ${reference.name} on for ${name}'s sessions, saved`);

    await open(page56);
    await heading("Folders and references");
    expect("Read only after a reload", await pressed(runbooks.name, "Read only"), "");
    expect("Read and write after a reload", await pressed(tokens.name, "Read and write"), "");
    expect(
      "the reference stays on after a reload",
      (await refSwitch.getAttribute("aria-checked")) === "true" ||
        (await refSwitch.getAttribute("data-checked")) !== null,
      await refSwitch.getAttribute("aria-checked"),
    );
    note("after a reload: both folders and the reference read back as saved");
    await shot("project-folders-owner-desktop-light");
    await paint("dark");
    await shot("project-folders-owner-desktop-dark");
    await paint("light");
    await page.setViewportSize(PHONE);
    await settled();
    await heading("Folders and references");
    await shot("project-folders-owner-phone-light");
    await paint("dark");
    await shot("project-folders-owner-phone-dark");
    await paint("light");
    await page.setViewportSize(DESKTOP);
    await settled();

    // --- A save the server refuses -----------------------------------------------------------
    stubs.set("projects.setFolders", {
      error: "A project mounts this folder. Try again later.",
    });
    await access(runbooks.name, "Off").click();
    await text(
      `Mend didn't change ${runbooks.name}. A project mounts this folder. Try again later. It's back as it was.`,
    ).waitFor();
    await waitFor("the folder goes back", () => pressed(runbooks.name, "Read only"));
    note("a refused save puts the folder back to Read only and says why under the section");
    await shot("project-folders-refused-desktop-light");
    stubs.delete("projects.setFolders");

    // --- host-mounts --------------------------------------------------------------------------
    const detail = await call("projects.detail", { id: project.id });
    if (detail.capabilities.hostMounts) {
      await heading("Server folders");
      await button("Add server folder…").click();
      await heading("Add server folder");
      await page.getByLabel("Path on the server", { exact: true }).fill("/tmp");
      await page.getByLabel("Mounted as", { exact: true }).fill(`pf-${stamp}-tmp`);
      await shot("project-folders-add-server-folder-desktop-light");
      await button("Add folder").click();
      await toastSays(`Added pf-${stamp}-tmp. New sessions in ${name} get it.`);
      await visible(page.getByRole("row", { name: `pf-${stamp}-tmp` })).waitFor();
      mountId =
        (await call("projects.mounts", { id: project.id })).find(
          (mount) => mount.name === `pf-${stamp}-tmp`,
        )?.id ?? null;
      note(`host-mounts: added /tmp as pf-${stamp}-tmp, Read only, as the operator`);
      await shot("project-folders-server-folder-desktop-light");
      await button(`Remove pf-${stamp}-tmp`).click();
      await toastSays(`Removed pf-${stamp}-tmp. New sessions start without it.`);
      await visible(page.getByRole("row", { name: `pf-${stamp}-tmp` })).waitFor({
        state: "detached",
      });
      mountId = null;
      note("host-mounts: removed it again");
    } else {
      // Host paths are a single-organization install's operator's to hand out (docs/adr/0003). On a
      // multi-tenant server nobody is offered them, an operator included, and a write is refused.
      const current = await call("organization.current");
      if (current.tenancy === "single" && current.operator)
        throw new Error("the operator of a single install is not offered server folders");
      if ((await page.getByRole("heading", { name: "Server folders" }).count()) !== 0)
        throw new Error("the page shows Server folders to someone the server doesn't offer them");
      if (current.tenancy === "multi") {
        const refusal = await call(
          "projects.addMount",
          {
            id: project.id,
            mount: {
              name: `pf-${stamp}-tmp`,
              hostPath: "/tmp",
              readOnly: true,
            },
          },
          "mutate",
        ).then(
          () => null,
          (error) => String(error?.message ?? error),
        );
        const mounts = await call("projects.mounts", { id: project.id });
        if (refusal === null || mounts.some((mount) => mount.name === `pf-${stamp}-tmp`)) {
          mountId = mounts.find((mount) => mount.name === `pf-${stamp}-tmp`)?.id ?? mountId ?? null;
          throw new Error("a multi-tenant server took a server folder");
        }
        note(
          `host-mounts: this server runs several organizations (tenancy multi), so even its operator (operator ${current.operator}) is offered no Server folders section, and adding /tmp as pf-${stamp}-tmp is refused: ${refusal.slice(0, 160)}; the project has no server folder`,
        );
      } else {
        note(
          "host-mounts: this account is not the operator of this single install; section not offered",
        );
      }
    }

    // --- Someone who may only read it (rewritten) ---------------------------------------------
    stubs.set("projects.detail", (answer) => {
      const data = answer?.result?.data?.json;
      if (data === undefined) return answer;
      return {
        result: {
          data: {
            ...answer.result.data,
            json: {
              ...data,
              project: { ...data.project, createdByUserId: null },
              capabilities: {
                ...data.capabilities,
                manage: false,
                hostMounts: false,
              },
            },
          },
        },
      };
    });
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(page56);
    await heading("Folders and references");
    await visible(page.getByText(/can change these settings\. You can read them\./)).waitFor();
    expect(
      "no access control for a reader",
      (await page.getByRole("group", { name: `Access to ${runbooks.name}` }).count()) === 0,
      "",
    );
    await visible(
      page.getByRole("row", { name: runbooks.name }).getByText("Read only", { exact: true }),
    ).waitFor();
    note(
      "as a reader (capabilities.manage false): who can change it, each folder's access as words",
    );
    await noToasts();
    await shot("project-folders-reader-desktop-light");
    stubs.delete("projects.detail");

    // --- Nothing here yet (rewritten) ---------------------------------------------------------
    stubs.set("folders.list", { json: [] });
    stubs.set("git.references", { json: [] });
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(page56);
    await text(`${organization} has no folders yet.`).waitFor();
    await text(`${organization} has no references yet.`).waitFor();
    note("an organization with no folders or references says so in each section");
    await noToasts();
    await shot("project-folders-empty-desktop-light");
    stubs.delete("folders.list");
    stubs.delete("git.references");

    // --- A read that fails (rewritten) --------------------------------------------------------
    stubs.set("projects.folders", { error: "Mend is unreachable." });
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(page56);
    await visible(page.getByRole("button", { name: "Try again" })).waitFor({
      timeout: 30_000,
    });
    note("a folders read that fails shows the error screen with Try again");
    await shot("project-folders-failed-desktop-light");
    stubs.delete("projects.folders");
    await visible(page.getByRole("button", { name: "Try again" })).click();
    await heading("Folders and references");
    note("Try again loads the page");

    // --- link-project, on General -------------------------------------------------------------
    await navigate(`/projects/${project.id}/settings/general`);
    await heading("General");
    await heading("Linked projects");
    await text("No linked projects.").waitFor();
    await button("Link project…").click();
    await heading("Link project");
    const linkDialog = visible(page.getByRole("dialog", { name: "Link project" }));
    await linkDialog.locator("select#link-project-which").selectOption({ label: sibling.name });
    await linkDialog.getByLabel("Mounted as", { exact: true }).fill("web");
    await shot("project-general-link-dialog-desktop-light");
    await button("Link project").click();
    await toastSays(
      `Linked ${sibling.name}. New sessions in ${name} get it at /workspace/repos/web.`,
    );
    const linkRow = visible(page.getByRole("row", { name: "web" }));
    await visible(linkRow.getByText("/workspace/repos/web", { exact: true })).waitFor();
    const links = await call("projects.links", { id: project.id });
    expect("the server holds the link", links.length === 1 && links[0].name === "web", links);
    note(`link-project: linked ${sibling.name} as web, worktree ${links[0].worktreeName}`);
    await shot("project-general-linked-desktop-light");
    await page.setViewportSize(PHONE);
    await settled();
    await heading("Linked projects");
    await visible(page.getByRole("heading", { name: "Linked projects" })).scrollIntoViewIfNeeded();
    await shot("project-general-linked-phone-light");
    await page.setViewportSize(DESKTOP);
    await settled();
    await button(`Unlink ${sibling.name}`).click();
    await toastSays("Unlinked web. New sessions start without it.");
    await text("No linked projects.").waitFor();
    note("link-project: unlinked it again");
  } finally {
    stubs.clear();
    if (mountId !== null)
      await call("projects.removeMount", { id: project.id, mountId }, "mutate").catch(
        () => undefined,
      );
    for (const link of await call("projects.links", { id: project.id }).catch(() => []))
      await call("projects.removeLink", { id: project.id, linkId: link.id }, "mutate").catch(
        () => undefined,
      );
    await call("projects.setFolders", { id: project.id, selections: [] }, "mutate").catch(
      () => undefined,
    );
    await call(
      "projects.selectReferences",
      { id: project.id, selection: { referenceIds: [] } },
      "mutate",
    ).catch(() => undefined);
    for (const folder of [runbooks, tokens])
      await call("folders.remove", { id: folder.id }, "mutate").catch(() => undefined);
    await call("git.removeReference", { id: reference.id }, "mutate").catch(() => undefined);
    for (const made of [project, sibling]) {
      await call("projects.remove", { id: made.id }, "mutate").catch(() => undefined);
      await call("projects.purge", { id: made.id, confirm: made.name }, "mutate").catch(
        () => undefined,
      );
    }
    note("removed the folders, the reference and both projects the recipe made");
  }
};
