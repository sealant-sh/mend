// Your skills in the new web app (route PR 31, SLNT-1133): /skills and /skills/<id>.
//
//   pnpm verify drive new-web --recipe new-web-skills
//
// Feature ids (skills.md): `skills-list` (the list, with search over it), `skills-web-create` (New
// skill…, each field's rule beside the field), `skills-web-edit` (description, files, add and remove
// a file, Edit and Preview, what is unsaved, Leave without saving?, and a save refused because a
// newer revision was saved from a second browser first), `skills-web-remove` (Remove skill… asks,
// says what it means, and a skill already removed elsewhere says so). Also: a skill of yours whose
// name a project's skill also has says the project's is used there (a project cloned from a small
// public repository, with its own skill); nothing yet; loading; a list that fails to load and Try
// again; the phone width. The stack reaches GitHub. A fixture (captures named `fixture-…`): no
// skills, when the stack's account already has some.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const SMALL_REPOSITORY = "https://github.com/octocat/Spoon-Knife.git";
// What an earlier run of this recipe left when it stopped partway.
const LEFT = /^(pr-descriptions|commit-messages|flaky-test-hunting|release-notes)-[a-z0-9]{4}$/;
const LEFT_PROJECT = /^skills-twin-[a-z0-9]{4}$/;

const visible = (locator) => locator.filter({ visible: true }).first();

/** React has taken the page over, so clicks, typing and the router reach it. */
const hydrated = async (on) => {
  await on.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  await on.waitForFunction(() =>
    [...document.querySelectorAll("a[href], button")].some((element) =>
      Object.keys(element).some((key) => key.startsWith("__reactProps")),
    ),
  );
};
const skillMd = (name, description, body) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
/** A tRPC answer (one, or each of a batch) with its list emptied. */
const empty = (answer) =>
  answer?.result?.data ? { result: { data: { ...answer.result.data, json: [] } } } : answer;

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };

  const open = async (path, on = page) => {
    await on.goto(`${web}${path}`);
    await hydrated(on);
    // The dev server may reload the page once as it bundles a module it hadn't seen: wait it out.
    await on.waitForTimeout(1_500);
    await hydrated(on);
  };
  const go = (to, search) =>
    page.evaluate(
      ({ path, query }) =>
        window["__TSR_ROUTER__"].navigate({ to: path, ...(query ? { search: query } : {}) }),
      { path: to, query: search },
    );
  const text = (words, on = page) => visible(on.getByText(words));
  const button = (name, on = page) => visible(on.getByRole("button", { name, exact: true }));
  const dialog = () => visible(page.getByRole("dialog"));
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true }));
  const row = (name) => visible(page.getByRole("link", { name: new RegExp(`^${name}`) }));
  const toast = (words) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(words));
  /** A tRPC call from the page, as the signed-in person. */
  const call = (path, input, kind = "query") =>
    page.evaluate(
      async ({ path: route, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { path, input, kind },
    );
  const refresh = () =>
    page.evaluate(() => {
      void window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries();
    });
  const waitFor = async (what, check, seconds) => {
    for (let waited = 0; waited < seconds; waited += 2) {
      const answer = await check();
      if (answer !== null && answer !== undefined && answer !== false) return answer;
      await page.waitForTimeout(2_000);
    }
    throw new Error(`${what} did not happen within ${seconds} s`);
  };
  const suffix = Math.random().toString(36).slice(2, 6);
  const names = {
    created: `pr-descriptions-${suffix}`,
    edited: `flaky-test-hunting-${suffix}`,
    twin: `commit-messages-${suffix}`,
    removed: `release-notes-${suffix}`,
  };

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/");
  for (const skill of (await call("skills.list")).filter((entry) => LEFT.test(entry.name)))
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  for (const project of (await call("projects.list")).filter((entry) =>
    LEFT_PROJECT.test(entry.name),
  ))
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);

  // Nothing yet: real when the account has no skills, a fixture when it has some.
  const before = await call("skills.list");
  if (before.length > 0) {
    await page.route("**/trpc/**skills.list**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ response, json: Array.isArray(body) ? body.map(empty) : empty(body) });
    });
  }
  // The sidebar's Skills opens the page.
  await visible(page.getByRole("link", { name: "Skills", exact: true })).click();
  await heading("No skills yet").waitFor();
  if (new URL(page.url()).pathname !== "/skills")
    throw new Error(`the sidebar's Skills went to ${page.url()}`);
  await text("mend skills push").waitFor();
  await both(`${before.length > 0 ? "fixture-" : ""}none-yet-desktop`);
  await page.setViewportSize(PHONE);
  await both(`${before.length > 0 ? "fixture-" : ""}none-yet-phone`);
  await page.setViewportSize(DESKTOP);
  note(
    `skills-list: no skills yet${before.length > 0 ? " (fixture: the account had skills)" : ""}`,
  );

  // skills-web-create: New skill… from the empty page, its front matter filled from the fields.
  await button("New skill…").click();
  await dialog().getByRole("heading", { name: "New skill" }).waitFor();
  await dialog().getByLabel("Name", { exact: true }).fill(names.created);
  await dialog()
    .getByLabel("Description", { exact: true })
    .fill("Write a pull request description from the change and its checkpoints.");
  const contents = dialog().getByLabel("SKILL.md", { exact: true });
  const filled = await contents.inputValue();
  if (!filled.includes(`name: ${names.created}`) || !filled.includes("description: Write a pull"))
    throw new Error(`New skill didn't fill the front matter: ${filled.slice(0, 160)}`);
  await contents.fill(
    skillMd(
      names.created,
      "Write a pull request description from the change and its checkpoints.",
      "# Pull request descriptions\n\nStart with one sentence on what changed and why.\nList the tests that ran, with how many passed.",
    ),
  );
  await both("new-skill-desktop");
  if (before.length > 0) await page.unroute("**/trpc/**skills.list**");
  await dialog().getByRole("button", { name: "Create skill", exact: true }).click();
  await toast(`Created ${names.created}`).waitFor();
  await page.waitForURL(/\/skills\/[^/?]+$/);
  await text("Your skill. You created it just now.").waitFor();
  await row(names.created).waitFor();
  await both("created-desktop");
  note("skills-web-create: created, opened beside the list, toast says so");

  // Each field's rule beside its field, and nothing sent while one is broken.
  let created = 0;
  const countCreates = (request) => {
    if (request.url().includes("skills.create")) created += 1;
  };
  page.on("request", countCreates);
  await button("New skill…").click();
  await dialog().getByLabel("Name", { exact: true }).fill(names.created);
  await dialog().getByLabel("Description", { exact: true }).fill("x".repeat(1310));
  // Just over 512 KB, set at once: typing half a megabyte would take minutes.
  await page.evaluate(
    (value) => {
      const area = document.querySelector('[role="dialog"] textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      set.call(area, value);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    },
    skillMd(names.created, "too big", "y".repeat(520 * 1024)),
  );
  await dialog().getByRole("button", { name: "Create skill", exact: true }).click();
  await text(`You already have a skill named ${names.created}. Pick another name.`).waitFor();
  await text("A description can be 1,024 characters at most. This one has 1,310.").waitFor();
  await text(
    /SKILL\.md is 52\d KB\. A file in a skill can be 512 KB at most, so trim it\./,
  ).waitFor();
  const nameField = dialog().getByLabel("Name", { exact: true });
  if ((await nameField.getAttribute("aria-invalid")) !== "true")
    throw new Error("the Name field isn't marked invalid");
  // The page's snapshot with half a megabyte in it takes the driver minutes to check: the size rule
  // is checked above, and the picture is taken with the file back to a short one.
  await dialog()
    .getByLabel("SKILL.md", { exact: true })
    .fill(skillMd(names.created, "short", "# Short again"));
  await text("A description can be 1,024 characters at most. This one has 1,310.").waitFor();
  await both("fields-need-fixing-desktop");
  await nameField.fill("Bad name");
  await text("Use only lowercase letters, digits, dots, dashes and underscores.").waitFor();
  await nameField.fill("-bad");
  await text("Start the name with a lowercase letter or a digit.").waitFor();
  await nameField.fill("");
  await text("Give the skill a name.").waitFor();
  await settled();
  if (created > 0) throw new Error("New skill sent a skill with a broken field");
  page.off("request", countCreates);
  await button("Cancel").click();
  await dialog().waitFor({ state: "hidden" });
  note(
    "each field's rule shows beside it (taken, pattern, start, empty, 1,024 characters, 512 KB); nothing sent",
  );

  // A project with its own skill of the same name as one of yours.
  const projectName = `skills-twin-${suffix}`;
  await call("projects.adopt", { name: projectName, source: SMALL_REPOSITORY }, "mutate");
  const project = await waitFor(
    "the project to be added",
    async () => (await call("projects.list")).find((entry) => entry.name === projectName),
    120,
  );
  const twinBody = "# Commit messages\n\nWrite the summary in the imperative, under 72 characters.";
  await call(
    "skills.create",
    {
      scope: "project",
      projectId: project.id,
      name: names.twin,
      description: "The project's own commit messages.",
      files: [{ path: "SKILL.md", contents: skillMd(names.twin, "The project's own.", twinBody) }],
    },
    "mutate",
  );
  const twin = await call(
    "skills.create",
    {
      scope: "user",
      projectId: null,
      name: names.twin,
      description: "Write a one-line summary, then say why the change was needed.",
      files: [
        { path: "SKILL.md", contents: skillMd(names.twin, "Write a one-line summary.", twinBody) },
      ],
    },
    "mutate",
  );
  const flaky = await call(
    "skills.create",
    {
      scope: "user",
      projectId: null,
      name: names.edited,
      description: "Repeat a failing test 200 times and log the seed of each failure.",
      files: [
        {
          path: "SKILL.md",
          contents: skillMd(
            names.edited,
            "How to chase a test that fails some of the time.",
            "# Flaky test hunting\n\nRun the failing test 200 times.\n\nLog the seed of every failure.\n\n## When you report\n\n- Say how many of the 200 runs failed.\n- Name the seed that reproduces it.\n- Don't call it fixed until 200 runs pass.",
          ),
        },
      ],
    },
    "mutate",
  );
  const doomed = await call(
    "skills.create",
    {
      scope: "user",
      projectId: null,
      name: names.removed,
      description: "Draft release notes from merged pull requests.",
      files: [
        {
          path: "SKILL.md",
          contents: skillMd(names.removed, "Draft release notes.", "# Release notes"),
        },
      ],
    },
    "mutate",
  );
  await go("/skills");
  await refresh();
  await text(`${projectName} uses its own`).waitFor();
  await row(names.twin).click();
  await text(
    `Used in every session you start, except in ${projectName}: ${projectName} has its own ${names.twin}, and its sessions use that one.`,
  ).waitFor();
  await visible(page.getByRole("link", { name: `Open ${projectName}'s skill` })).waitFor();
  await both("same-name-desktop");
  note(
    "a skill of yours whose name a project's skill has: the row and the skill say the project's is used there",
  );

  // skills-list: search filters the list and marks each match; no matches; Clear search.
  await go("/skills");
  const search = page.getByRole("searchbox", { name: "Search your skills" });
  await search.fill("flaky");
  await text(/^1 of \d+ match "flaky"$/).waitFor();
  await row(names.edited).waitFor();
  if ((await page.locator("mark").count()) === 0) throw new Error("search marks no match");
  await both("search-desktop");
  await search.fill("deploy-nothing-here");
  await text('No skills match "deploy-nothing-here".').waitFor();
  await both("no-matches-desktop");
  await button("Clear search").click();
  await row(names.edited).waitFor();
  note(
    "skills-list: search filters by name and description, marks matches, and says when none match",
  );

  // skills-web-edit: the editor replaces the reading view.
  await row(names.edited).click();
  await heading(names.edited).waitFor();
  await both("open-desktop");
  await button("Edit skill").click();
  await page.waitForURL(/[?&]edit=1/);
  await text(/Your skill, revision 1\. Saving makes revision 2\./).waitFor();
  if ((await page.getByRole("searchbox", { name: "Search your skills" }).count()) > 0)
    throw new Error("the list is still on the page while editing");
  const editor = () => visible(page.getByRole("textbox", { name: "Contents of SKILL.md" }));
  const original = await editor().inputValue();
  await editor().fill(
    original.replace(
      "Run the failing test 200 times.",
      "Read references/ci-logs.md first: it lists the seeds CI saw fail last week.\n\nRun the failing test 200 times.",
    ),
  );
  await text("1 file changed, not saved").waitFor();
  await text(/^\d+ lines? changed$/).waitFor();
  // Add a file: a path that escapes the skill is refused; a good one is added and opened.
  await visible(page.getByRole("button", { name: "Add a file" })).click();
  const path = visible(page.getByLabel("New file path"));
  await path.fill("../outside.md");
  await path.press("Enter");
  await text('A path can\'t have empty, "." or ".." parts.').waitFor();
  await path.fill("references/ci-logs.md");
  await both("add-a-file-desktop");
  await path.press("Enter");
  await visible(page.getByRole("textbox", { name: "Contents of references/ci-logs.md" })).fill(
    "Seeds CI saw fail last week: 1182, 77, 4096.",
  );
  await text("2 files changed, not saved").waitFor();
  // Remove a file: one added and then taken out again leaves nothing to save for it.
  await visible(page.getByRole("button", { name: "Add a file" })).click();
  await visible(page.getByLabel("New file path")).fill("notes/scratch.md");
  await visible(page.getByLabel("New file path")).press("Enter");
  await text("3 files changed, not saved").waitFor();
  await visible(page.getByRole("button", { name: "Remove notes/scratch.md" })).click();
  await text("2 files changed, not saved").waitFor();
  await visible(page.getByRole("button", { name: "SKILL.md", exact: false })).click();
  await both("editing-desktop");
  // Preview reads the file as an agent does.
  await button("Preview").click();
  await visible(page.getByRole("heading", { name: "Flaky test hunting" })).waitFor();
  await both("preview-desktop");
  await button("Edit").click();
  note(
    "skills-web-edit: description and files edited, a file added and one removed, lines marked, Preview",
  );

  // Leaving another way asks first; Keep editing stays.
  await visible(page.getByRole("link", { name: "Skills", exact: true })).click();
  await page.getByRole("heading", { name: "Leave without saving?" }).waitFor();
  await text(`You changed 2 files in ${names.edited} and haven't saved them.`, page).waitFor();
  await both("leave-desktop");
  await button("Keep editing").click();
  await editor().waitFor();
  note("leaving with unsaved changes asks Leave without saving?; Keep editing keeps the draft");

  // A second browser saves first: this draft is warned, then its save is refused, and kept.
  const other = await page
    .context()
    .browser()
    .newContext({ viewport: DESKTOP, storageState: await page.context().storageState() });
  const second = await other.newPage();
  await open(`/skills/${flaky.skill.id}?edit=1`, second);
  const otherDescription = visible(second.getByLabel("Description", { exact: true }));
  await otherDescription.fill("How to chase a test that fails some of the time. Saved elsewhere.");
  await button("Save skill", second).click();
  await text(`Saved ${names.edited}`, second).waitFor();
  await other.close();
  await refresh();
  await text("Revision 2 was saved somewhere else.").waitFor();
  await both("newer-arrived-desktop");
  await button("Save skill").click();
  await text(/^Not saved\.$/).waitFor();
  await text(/You saved revision 2 of .* somewhere else, from another browser/).waitFor();
  if (!(await editor().inputValue()).includes("references/ci-logs.md"))
    throw new Error("the refused draft lost its edits");
  await both("saved-elsewhere-desktop");
  note(
    "a save over a revision saved from a second browser is refused, says so, and keeps the draft",
  );
  await button("Load revision 2").click();
  await text("No changes").waitFor();
  await editor().fill(`${await editor().inputValue()}\n- Link the CI run where it first failed.`);
  await button("Save skill").click();
  await toast(`Saved ${names.edited}`).waitFor();
  await text("Your skill, revision 3. You saved it just now.").waitFor();
  await text(
    "New sessions get this version. Sessions that already started keep revision 2.",
  ).waitFor();
  await both("saved-desktop");
  note("Load revision 2 drops the draft; the next save makes revision 3");

  // Discard changes doesn't ask.
  await button("Edit skill").click();
  await editor().fill(`${await editor().inputValue()}\nthrown away`);
  await button("Discard changes").click();
  await heading(names.edited).waitFor();
  if ((await page.getByRole("heading", { name: "Leave without saving?" }).count()) > 0)
    throw new Error("Discard changes asked");

  // skills-web-remove: the "…" menu, the confirmation, the toast.
  await go(`/skills/${doomed.skill.id}`);
  await heading(names.removed).waitFor();
  // The header's own Remove skill button, beside Edit skill (SLNT-1229).
  await both("header-desktop");
  await visible(page.getByRole("button", { name: "Remove skill", exact: true })).click();
  await dialog()
    .getByRole("heading", { name: `Remove ${names.removed}?` })
    .waitFor();
  await both("remove-desktop");
  await dialog().getByRole("button", { name: "Remove skill", exact: true }).click();
  await toast(`Removed ${names.removed}`).waitFor();
  await page.waitForURL(/\/skills$/);
  await settled();
  if ((await page.getByRole("link", { name: new RegExp(`^${names.removed}`) }).count()) > 0)
    throw new Error("the removed skill is still listed");
  await both("removed-desktop");
  // Removed elsewhere first: the dialog says so and offers only Close.
  await go(`/skills/${twin.skill.id}`);
  await heading(names.twin).waitFor();
  await visible(page.getByRole("button", { name: "Remove skill", exact: true })).click();
  await call("skills.remove", { skillId: twin.skill.id }, "mutate");
  await dialog().getByRole("button", { name: "Remove skill", exact: true }).click();
  await text("Already removed.").waitFor();
  await both("cant-remove-desktop");
  await button("Close").click();
  await page.waitForURL(/\/skills$/);
  // A removed skill's address says it isn't here, with a way back.
  await go(`/skills/${twin.skill.id}`);
  await text("This skill isn't here.").waitFor();
  await both("gone-desktop");
  note(
    "skills-web-remove: asked first, toast, gone from the list; removed elsewhere says Already removed",
  );

  // Loading, then a list that fails to load and Try again.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.removeQueries({ queryKey: [["skills"]] }),
  );
  await page.route("**/trpc/**skills.list**", async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  await go("/");
  await go("/skills");
  await text("Loading…").waitFor();
  await both("loading-desktop");
  release();
  await page.unroute("**/trpc/**skills.list**");
  await row(names.edited).waitFor();
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.removeQueries({ queryKey: [["skills"]] }),
  );
  const failure = {
    error: {
      json: {
        message: "The verify recipe failed this read on purpose.",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    },
  };
  await page.route("**/trpc/**skills.list**", (route) => {
    const url = new URL(route.request().url());
    const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify(url.searchParams.has("batch") ? calls.map(() => failure) : failure),
    });
  });
  await go("/");
  await go("/skills");
  await text("Couldn't load your skills.").waitFor();
  await text("The verify recipe failed this read on purpose.").waitFor();
  await both("couldnt-load-desktop");
  await page.setViewportSize(PHONE);
  await both("couldnt-load-phone");
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**skills.list**");
  await button("Try again").click();
  await row(names.edited).waitFor();
  note("loading shows the list's outline; a failed read says so with Try again, which recovers");

  // The phone: the list with the tab bar, a skill on its own screen, its actions, the editor, New skill.
  await page.setViewportSize(PHONE);
  await go("/skills");
  await row(names.edited).waitFor();
  await both("list-phone");
  await row(names.edited).click();
  await heading(names.edited).waitFor();
  await both("skill-phone");
  await visible(page.getByRole("button", { name: `Actions for ${names.edited}` })).click();
  await visible(page.getByRole("button", { name: "Remove skill…" })).waitFor();
  await both("actions-phone");
  await visible(page.getByRole("button", { name: "Edit skill" })).click();
  await editor().waitFor();
  await editor().fill(`${await editor().inputValue()}\nOne more line.`);
  await text("1 file changed, not saved").waitFor();
  await both("editing-phone");
  await visible(page.getByRole("button", { name: "Add a file" })).click();
  await visible(page.getByLabel("New file path")).fill("references/more.md");
  await both("add-a-file-phone");
  await visible(page.getByRole("button", { name: "Cancel" })).click();
  await button("Discard changes").click();
  await heading(names.edited).waitFor();
  await go("/skills");
  await visible(page.getByRole("button", { name: "New skill" })).click();
  await dialog().getByLabel("Name", { exact: true }).fill(`pr-descriptions-${suffix}`);
  await dialog().getByRole("button", { name: "Create skill", exact: true }).click();
  await text(/You already have a skill named/).waitFor();
  await both("new-skill-phone");
  await button("Cancel").click();
  await page.setViewportSize(DESKTOP);
  note(
    "the phone: list with the tab bar, a skill as its own screen, its actions sheet, the editor, New skill",
  );

  // Leave the account as it was.
  for (const skill of (await call("skills.list")).filter((entry) => LEFT.test(entry.name)))
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  const twins = await call("skills.forProject", { id: project.id });
  for (const skill of twins)
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
  note("removed the skills and the project this run made");
};
