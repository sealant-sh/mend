// The repository list asks GitHub's API from the server, with Mend's own sealed copy of the
// person's GitHub login, and starts no workspace (SLNT-1194, docs/adr/0028). On a stack nobody has
// connected a GitHub login, and the stack's sealant checks a GitHub token against the real
// api.github.com before it keeps one, so no stand-in login can be connected here: this recipe
// proves, through the real server, what someone with no copy sees on First project and in Add
// project, that the three GitHub reads answer at once with no workspace started, and that the
// pages never mention a short-lived workspace. The list itself, as a connected login, is proven
// against a stand-in for GitHub's API in apps/api/src/routes/github-postgres.test.ts.
//
//   pnpm verify drive web --recipe github-list
const DESKTOP = { width: 1280, height: 900 };

const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};

export default async ({ page, web, capture, note }) => {
  const hydrated = () =>
    page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  /** One API call from the page, timed: status, body. */
  const api = (path) =>
    page.evaluate(async (address) => {
      const started = performance.now();
      const response = await fetch(address, { headers: { accept: "application/json" } });
      const text = await response.text();
      return {
        status: response.status,
        body: text === "" ? null : JSON.parse(text),
        ms: Math.round(performance.now() - started),
      };
    }, `${web}${path}`);

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await page.goto(`${web}/projects`);
  await hydrated();

  const workspacesBefore = await api("/api/sessions");
  const status = await api("/api/github/status");
  expect("github.status answers", status.status === 200, status);
  expect(
    "this stack holds no GitHub login for its account",
    status.body.authenticated === false,
    status.body,
  );
  note(
    `github.status: ${status.status} in ${status.ms} ms, authenticated false, connectAgain ${status.body.connectAgain === true}, detail "${status.body.detail ?? ""}"`,
  );
  const owners = await api("/api/github/owners");
  const repos = await api("/api/github/repos?owner=northwind");
  for (const [name, read] of [
    ["github.owners", owners],
    ["github.repos", repos],
  ]) {
    expect(`${name} answers with a sentence, not a list`, read.status === 422, read);
    expect(
      `${name}'s sentence names no workspace`,
      !/workspace/i.test(read.body.message),
      read.body,
    );
    note(`${name}: ${read.status} in ${read.ms} ms, "${read.body.message}"`);
  }
  const workspacesAfter = await api("/api/sessions");
  expect(
    "no session or workspace started for the three reads",
    JSON.stringify(workspacesAfter.body) === JSON.stringify(workspacesBefore.body),
    { before: workspacesBefore.body, after: workspacesAfter.body },
  );
  note("the sessions list is the same before and after the three GitHub reads: none started");

  // First project, with no login Mend can list with: how to connect GitHub, and no workspace line.
  await page.goto(`${web}/welcome/first-project`);
  await hydrated();
  await page.getByText("Connect GitHub and Mend lists your repositories").first().waitFor();
  const firstProject = await page.locator("body").innerText();
  expect(
    "First project never mentions a short-lived workspace",
    !/short-lived/i.test(firstProject),
    "",
  );
  note(
    "First project shows how to connect GitHub (mend connect github), and no short-lived workspace line",
  );
  await capture("first-project-no-login-desktop-light");

  // Add project: with no login it opens on a Git URL; From GitHub says the server can't list.
  await page.goto(`${web}/projects?add=true`);
  await hydrated();
  const dialog = page.getByRole("dialog", { name: "Add project" });
  await dialog.waitFor();
  await dialog.getByRole("tab", { name: "From GitHub" }).click();
  await dialog
    .getByText(/can't list repositories|Connect GitHub again/)
    .first()
    .waitFor();
  expect(
    "Add project never mentions a short-lived workspace",
    !/short-lived/i.test(await dialog.innerText()),
    "",
  );
  note("Add project's From GitHub tab says why it can't list, with no short-lived workspace line");
  await capture("add-project-no-login-desktop-light");
};
