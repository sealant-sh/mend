// A project's skills in the web app (route PR 32, SLNT-1156): the project's Skills tab,
// /projects/<id>/skills and /projects/<id>/skills/<skillId>.
//
//   pnpm verify drive web --recipe project-skills
//
// Feature ids (skills.md, in a project's library): `skills-list` (the tab lists the project's
// skills, each saying when it changed or that it is used instead of yours), `skills-web-create`
// (New skill… on a project, from an empty skill or a copy of one of yours, with each field's rule),
// `skills-web-edit` (the editor in place of the whole project page, saved for everyone's new
// sessions there), `skills-web-remove` (Remove skill… says your own of that name is used again; a
// project being removed refuses it). `skills-project-inherit` is dropped: there is no "Use global
// skills" switch (owner ruling, 16 Nov). Also: a project skill wins over yours with the same name,
// and both your skill and the project's say which is used, each linking to the other; nothing yet;
// loading; a list that fails to load and Try again; the phone width. Fixtures (captures named
// `fixture-…`): the read-only view of someone who may not change the project's skills (the stack runs
// one account, who added the project), and a removal refused because the project is being removed.
// The stack reaches GitHub.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const SMALL_REPOSITORY = "https://github.com/octocat/Spoon-Knife.git";
// What an earlier run of this recipe left when it stopped partway.
const LEFT = /^(commit-messages|flaky-test-hunting|stripe-idempotency)-[a-z0-9]{4}$/;
const LEFT_PROJECT = /^project-skills-[a-z0-9]{4}$/;

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
/** The tRPC calls a request carries, batched or not. */
const callsOf = (url) =>
  decodeURIComponent(new URL(url).pathname.replace(/^\/trpc\//, "")).split(",");

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const light = async (name) => {
    await settled();
    await capture(`${name}-light`);
  };
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated(page);
    // The dev server may reload the page once as it bundles a module it hadn't seen: wait it out.
    await page.waitForTimeout(1_500);
    await hydrated(page);
  };
  const go = (to, search) =>
    page.evaluate(
      ({ path, query }) =>
        window["__TSR_ROUTER__"].navigate({ to: path, ...(query ? { search: query } : {}) }),
      { path: to, query: search },
    );
  const text = (words) => visible(page.getByText(words));
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
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
  const forget = (key) =>
    page.evaluate(
      (root) =>
        window["__TSR_ROUTER__"].options.context.queryClient.removeQueries({
          queryKey: [[root]],
        }),
      key,
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
  /** Rewrites the answers to some tRPC calls, leaving every other call in a batch as it is. */
  const rewrite = (paths, edit) =>
    page.route("**/trpc/**", async (route) => {
      const calls = callsOf(route.request().url());
      if (!calls.some((path) => paths.includes(path))) return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      const each = (answer, at) =>
        paths.includes(calls[at]) && answer?.result?.data
          ? {
              result: {
                data: { ...answer.result.data, json: edit(calls[at], answer.result.data.json) },
              },
            }
          : answer;
      return route.fulfill({
        response,
        json: Array.isArray(body) ? body.map(each) : each(body, 0),
      });
    });
  /** Answers one tRPC call with a refusal, or a failure, each call of its batch alike. */
  const refuse = (path, error) =>
    page.route(`**/trpc/**${path}**`, (route) => {
      const url = new URL(route.request().url());
      const calls = callsOf(route.request().url());
      return route.fulfill({
        status: error.data.httpStatus,
        contentType: "application/json",
        body: JSON.stringify(
          url.searchParams.has("batch")
            ? calls.map(() => ({ error: { json: error } }))
            : { error: { json: error } },
        ),
      });
    });

  const suffix = Math.random().toString(36).slice(2, 6);
  const names = {
    own: `stripe-idempotency-${suffix}`,
    shared: `commit-messages-${suffix}`,
    other: `flaky-test-hunting-${suffix}`,
  };
  const projectName = `project-skills-${suffix}`;

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/");
  for (const skill of (await call("skills.list")).filter((entry) => LEFT.test(entry.name)))
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  for (const project of (await call("projects.list")).filter((entry) =>
    LEFT_PROJECT.test(entry.name),
  ))
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);

  // A project this account adds, so it may change the project's skills, and two skills of its own.
  await call("projects.adopt", { name: projectName, source: SMALL_REPOSITORY }, "mutate");
  const project = await waitFor(
    "the project to be added",
    async () => (await call("projects.list")).find((entry) => entry.name === projectName),
    120,
  );
  const yours = await call(
    "skills.create",
    {
      scope: "user",
      projectId: null,
      name: names.shared,
      description: "Write a one-line summary, then say why the change was needed.",
      files: [
        {
          path: "SKILL.md",
          contents: skillMd(
            names.shared,
            "Write a one-line summary.",
            "# Commit messages\n\nWrite the summary in the imperative, under 72 characters.",
          ),
        },
        { path: "references/examples.md", contents: "- Retry a 502 once\n- Name the ticket" },
      ],
    },
    "mutate",
  );
  await call(
    "skills.create",
    {
      scope: "user",
      projectId: null,
      name: names.other,
      description: "How to chase a test that fails some of the time.",
      files: [
        {
          path: "SKILL.md",
          contents: skillMd(names.other, "Chase a flaky test.", "# Flaky test hunting"),
        },
      ],
    },
    "mutate",
  );
  const tab = `/projects/${project.id}/skills`;

  // skills-list: the project's Skills tab with nothing yet, reached from the tab line.
  await go(`/projects/${project.id}`);
  await visible(
    page.getByRole("navigation", { name: `${projectName} project` }).getByRole("link", {
      name: /^Skills/,
    }),
  ).click();
  await page.waitForURL(new RegExp(`${tab}$`));
  await heading(`No skills in ${projectName} yet`).waitFor();
  await text("mend skills push --project").waitFor();
  await both("none-yet-desktop");
  note("skills-list: the Skills tab opens from the project's tabs; nothing yet says so");

  // skills-web-create: New skill… from an empty skill.
  await button("New skill…").click();
  await dialog()
    .getByRole("heading", { name: `New skill in ${projectName}` })
    .waitFor();
  await dialog().getByLabel("Name", { exact: true }).fill(names.own);
  await dialog()
    .getByLabel("Description", { exact: true })
    .fill("How the project uses idempotency keys and retries with Stripe.");
  await dialog()
    .getByLabel("SKILL.md", { exact: true })
    .fill(
      skillMd(
        names.own,
        "How the project uses idempotency keys and retries with Stripe.",
        "# Stripe idempotency\n\nEvery charge sends an Idempotency-Key built from the order id.\n\nRetry a 502 once, with the same key.",
      ),
    );
  await dialog().getByRole("button", { name: "Create skill", exact: true }).click();
  await toast(`Created ${names.own} in ${projectName}`).waitFor();
  await page.waitForURL(new RegExp(`${tab}/[^/?]+$`));
  await text(`${projectName}'s skill, revision 1. Created just now.`).waitFor();
  await text(`You and `).waitFor();
  await row(names.own).waitFor();
  await light("created-desktop");
  note("skills-web-create: an empty skill created in the project, opened beside its list, toast");

  // The rules: nothing picked to copy, and a name the project already has.
  let created = 0;
  const countCreates = (request) => {
    if (request.url().includes("skills.create")) created += 1;
  };
  page.on("request", countCreates);
  await go(tab);
  await button("New skill…").click();
  await dialog()
    .getByRole("radio", { name: "Copy one of your skills" })
    .or(dialog().getByRole("button", { name: "Copy one of your skills" }))
    .first()
    .click();
  await dialog().getByText(names.other).waitFor();
  await dialog().getByLabel(`Name in ${projectName}`, { exact: true }).fill(names.own);
  await dialog().getByRole("button", { name: "Create skill", exact: true }).click();
  await text("Pick one of your skills to copy.").waitFor();
  await text(`${projectName} already has a skill named ${names.own}. Pick another name.`).waitFor();
  await light("fields-need-fixing-desktop");
  await settled();
  if (created > 0) throw new Error("New skill sent a skill with a broken field");
  page.off("request", countCreates);
  note("each rule beside its field: pick one to copy; a name the project has; nothing sent");

  // A copy of one of yours, keeping its name: the dialog says the project's copy wins there.
  const copyName = dialog().getByLabel(`Name in ${projectName}`, { exact: true });
  await copyName.fill("");
  await dialog()
    .getByRole("radio", { name: new RegExp(`^${names.shared}`) })
    .click();
  if ((await copyName.inputValue()) !== names.shared)
    throw new Error(`picking a skill didn't name the copy: ${await copyName.inputValue()}`);
  await text(
    `With the same name as yours, ${projectName}'s copy is used in ${projectName} instead of yours.`,
  ).waitFor();
  await text(
    `The copy belongs to ${projectName}. Changing it later doesn't change yours.`,
  ).waitFor();
  await both("new-skill-copy-desktop");
  await dialog().getByRole("button", { name: "Create skill", exact: true }).click();
  await toast(`Added ${names.shared} to ${projectName}`).waitFor();
  await text(
    `Every new session in ${projectName} gets it. You have a skill with the same name, and this one is used instead of yours here.`,
  ).waitFor();
  await visible(page.getByRole("link", { name: "Open your skill" })).waitFor();
  await text("Used instead of yours").waitFor();
  const copies = await call("skills.forProject", { id: project.id });
  const copy = copies.find((entry) => entry.name === names.shared);
  const copied = await call("skills.detail", { skillId: copy.id });
  if (copied.files.length !== 2)
    throw new Error(`the copy has ${copied.files.length} files, not 2`);
  await both("copied-desktop");
  note(
    "a copy of one of yours with its name: both files copied; the dialog, the row and the skill say the project's is used instead of yours",
  );

  // Your own skill says the project's is used there, and its link lands on the project's skill.
  await visible(page.getByRole("link", { name: "Open your skill" })).click();
  await page.waitForURL(new RegExp(`/skills/${yours.skill.id}$`));
  await text(
    `Used in every session you start, except in ${projectName}: ${projectName} has its own ${names.shared}, and its sessions use that one.`,
  ).waitFor();
  await light("yours-says-project-wins-desktop");
  await visible(page.getByRole("link", { name: `Open ${projectName}'s skill` })).click();
  await page.waitForURL(new RegExp(`${tab}/${copy.id}$`));
  await heading(names.shared).waitFor();
  // The Skills tab stays the open tab while a skill is open.
  const skillsTab = visible(
    page.getByRole("navigation", { name: `${projectName} project` }).getByRole("link", {
      name: /^Skills/,
    }),
  );
  if ((await skillsTab.getAttribute("aria-current")) !== "page")
    throw new Error("the Skills tab isn't marked open while a skill is");
  note("your skill links to the project's, which opens on the project's Skills tab");

  // skills-web-edit: the editor replaces the whole project page.
  await button("Edit skill").click();
  await page.waitForURL(/[?&]edit=1/);
  await text(
    `${projectName}'s skill, revision 1. Saving makes revision 2 for everyone's new sessions in ${projectName}.`,
    { exact: false },
  ).waitFor();
  if ((await page.getByRole("navigation", { name: `${projectName} project` }).count()) > 0)
    throw new Error("the project's tabs are still on the page while editing");
  await visible(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText(projectName),
  ).waitFor();
  const editor = () => visible(page.getByRole("textbox", { name: "Contents of SKILL.md" }));
  await editor().fill(
    `${await editor().inputValue()}\nSay which migration the change needs, if any.\n`,
  );
  await text("1 file changed, not saved").waitFor();
  await both("editing-desktop");
  await button("Save skill").click();
  await toast(`Saved ${names.shared} in ${projectName}`).waitFor();
  await text(`${projectName}'s skill, revision 2. Saved just now.`).waitFor();
  await text(
    `Everyone's new sessions in ${projectName} get this version. Sessions that already started keep revision 1.`,
  ).waitFor();
  await light("saved-desktop");
  note(
    "skills-web-edit: edited in place of the project page, saved as revision 2 for everyone's new sessions",
  );

  // skills-web-remove: the header's own Remove skill button beside Edit skill (SLNT-1229), the
  // confirmation that says yours is used again, the toast.
  await light("header-desktop");
  await visible(page.getByRole("button", { name: "Remove skill", exact: true })).click();
  await dialog()
    .getByRole("heading", { name: `Remove ${names.shared} from ${projectName}?` })
    .waitFor();
  await dialog().getByText(`Your ${names.shared} is used here again`).waitFor();
  await dialog().getByText(`Everyone's new sessions in ${projectName}`).waitFor();
  await both("remove-desktop");
  await dialog().getByRole("button", { name: "Remove skill", exact: true }).click();
  await toast(`Removed ${names.shared} from ${projectName}`).waitFor();
  await page.waitForURL(new RegExp(`${tab}$`));
  await settled();
  if ((await page.getByRole("link", { name: new RegExp(`^${names.shared}`) }).count()) > 0)
    throw new Error("the removed skill is still listed");
  await light("removed-desktop");
  await go(`/skills/${yours.skill.id}`);
  await text("Used in every session you start.").waitFor();
  note(
    "skills-web-remove: asked first, says your own is used again, toast, gone; yours is used everywhere again",
  );

  // Fixture: a project being removed refuses the removal, and the dialog offers only Close.
  const own = (await call("skills.forProject", { id: project.id })).find(
    (entry) => entry.name === names.own,
  );
  await go(`${tab}/${own.id}`);
  await heading(names.own).waitFor();
  await refuse("skills.remove", {
    message: "the project is being removed",
    code: -32600,
    data: { code: "CONFLICT", httpStatus: 409, tag: "RemovalInProgress" },
  });
  await visible(page.getByRole("button", { name: "Remove skill", exact: true })).click();
  await dialog().getByRole("button", { name: "Remove skill", exact: true }).click();
  await text(
    `${projectName} is being removed, so its skills can't change. If ${projectName} is restored, try again.`,
  ).waitFor();
  if ((await dialog().getByRole("button", { name: "Keep skill" }).count()) > 0)
    throw new Error("a refused removal still offers Keep skill");
  await light("fixture-cant-remove-desktop");
  await button("Close").click();
  await page.unroute(`**/trpc/**skills.remove**`);
  note("fixture: a project being removed refuses Remove skill…, which says so and offers Close");

  // Fixture: someone who may not change the project's skills (not an owner, didn't add it).
  // The server answers `capabilities.manage` false for them; the members name who added it.
  await rewrite(["projects.detail", "organization.members"], (path, json) =>
    path === "projects.detail"
      ? {
          ...json,
          project: { ...json.project, createdByUserId: "fixture-grace" },
          capabilities: { ...json.capabilities, manage: false },
        }
      : [...json, { ...json[0], userId: "fixture-grace", name: "Grace Hopper", role: "member" }],
  );
  // The server rendered both into the page: past their stale time, a re-read takes the fixture.
  await page.waitForTimeout(5_500);
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await refresh();
  await text(`Grace Hopper, who added ${projectName}, and `, { exact: false }).waitFor();
  await text("You can read it.", { exact: false }).waitFor();
  if ((await page.getByRole("button", { name: "Edit skill" }).count()) > 0)
    throw new Error("someone who may not change it is offered Edit skill");
  if ((await page.getByRole("button", { name: "New skill…" }).count()) > 0)
    throw new Error("someone who may not change it is offered New skill…");
  await text("add and change them. You can read them.", { exact: false }).waitFor();
  await both("fixture-read-only-desktop");
  // Asking for the editor by its address reads the skill instead.
  await go(`${tab}/${own.id}`, { edit: 1 });
  await heading(names.own).waitFor();
  if ((await page.getByRole("textbox", { name: "Contents of SKILL.md" }).count()) > 0)
    throw new Error("someone who may not change it got the editor");
  await page.setViewportSize(PHONE);
  await go(`${tab}/${own.id}`);
  await text(`Revision 1. Created`, { exact: false }).waitFor();
  await both("fixture-read-only-phone");
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**");
  await refresh();
  note(
    "fixture: someone who may not change it reads, the page names who can, and ?edit=1 reads too",
  );

  // Loading, then a list that fails to load and Try again.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await go("/");
  await forget("skills");
  await page.route("**/trpc/**skills.forProject**", async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  await go(tab);
  await text(`Loading ${projectName}'s skills…`).waitFor({ state: "attached" });
  await light("loading-desktop");
  release();
  await page.unroute("**/trpc/**skills.forProject**");
  await row(names.own).waitFor();
  await go("/");
  await forget("skills");
  await refuse("skills.forProject", {
    message: "The verify recipe failed this read on purpose.",
    code: -32603,
    data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
  });
  await go(tab);
  await text(`Couldn't load ${projectName}'s skills.`).waitFor();
  await text("The verify recipe failed this read on purpose.").waitFor();
  await both("couldnt-load-desktop");
  await page.unroute("**/trpc/**skills.forProject**");
  await button("Try again").click();
  await row(names.own).waitFor();
  note("loading shows the list's outline; a failed read says so with Try again, which recovers");

  // The phone: the tab with New skill… under the list, a skill on its own screen, the copy sheet.
  await page.setViewportSize(PHONE);
  await go(tab);
  await row(names.own).waitFor();
  await both("list-phone");
  await row(names.own).click();
  await heading(names.own).waitFor();
  await visible(page.getByRole("link", { name: `Back to ${projectName}'s skills` })).waitFor();
  await both("skill-phone");
  await visible(page.getByRole("link", { name: `Back to ${projectName}'s skills` })).click();
  await button("New skill…").click();
  await dialog().getByRole("button", { name: "Copy one of yours" }).first().click();
  await dialog()
    .getByRole("radio", { name: new RegExp(`^${names.shared}`) })
    .click();
  await text(
    `With the same name as yours, ${projectName}'s copy is used in ${projectName} instead of yours.`,
  ).waitFor();
  await both("new-skill-phone");
  await button("Cancel").click();
  await page.setViewportSize(DESKTOP);
  note("the phone: the tab with New skill…, a skill as its own screen, New skill as a sheet");

  // Leave the account as it was.
  for (const skill of (await call("skills.list")).filter((entry) => LEFT.test(entry.name)))
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  for (const skill of await call("skills.forProject", { id: project.id }))
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
  note("removed the skills and the project this run made");
};
