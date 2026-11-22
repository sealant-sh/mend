// Landing a change in the web app (apps/web, route PR 26, SLNT-1152): Land… in the Change
// view's toolbar, the Land dialog, and what the view and the conversation say after a landing.
// Driven by land-change.md's `land-web`, `land-preview`, `land-again`, `land-refused`,
// `land-check` and `land-observe`. Run the CLI batch first, once per stack:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/land-sessions.json
//   pnpm verify drive web --recipe land
//
// The batch makes the worktree `land-retry` with `mend run` (two files, no agent), then starts a
// second session in it that keeps running (`sleep`), so the dialog has a session still editing.
// The recipe stops that session when it is done.
//
// Real, against the stack: Land… opens the dialog over `/sessions/<id>/change#land`; the dialog
// names the session still editing; the stack's git fixture serves fetches only, so Push to origin
// is a real landing that origin refuses, in git's own words, and Check origin reads origin again;
// the workspace "…" and `/changes/<id>#land` open the same dialog. On a check VM the project comes
// from GitHub: the real dialog is GitHub's (pull request base, title, Push and open pull request)
// and Check GitHub asks for real; nothing is pushed, and the fixtures below show the rest.
//
// Fixtures, laid over the real reads in the browser (a stack has no GitHub origin, and nothing here
// pushes to GitHub or opens a pull request): a push that goes through, with its toast and lines; a
// GitHub origin with the pull request title, your description and its Preview, and Push and open
// pull request answered with #412; the view after landing ("Checkpoint N is in pull request #412.");
// after more work (Land again… and "Update pull request #412"); GitHub refusing the push; the
// conversation's "landed as pull request #412" line; the phone's sheet; and a read that fails.
import { history, item, patchDetail, superjson, turn } from "./session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const TITLES = {
  owner: "Fix flaky checkout retry",
  editing: "Write tests for retry",
};
const PR_TITLE = "Fix duplicate charge when checkout retries";
const PR_URL = "https://github.com/northwind/checkout-api/pull/412";
const DESCRIPTION = "Fixes the duplicate charges that support reported on 12 November.";
const SHA = "c71e0a2d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49";

/** superjson's Date paths of a list of landings under `prefix`. */
const landingDates = (landings, prefix) =>
  landings.flatMap((each, index) => [
    `${prefix}${index}.createdAt`,
    ...(each.pullRequest === null ? [] : [`${prefix}${index}.pullRequest.observedAt`]),
  ]);

/** The first of `locator`'s matches a person can see: under 1024px some are in the page twice. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const clip = () =>
    // The sidebar's wrapper is 2px taller than the window: clip it, or a capture resizes the
    // window and the driver withholds every later picture.
    page.addStyleTag({
      content: "[data-slot=sidebar-wrapper]{max-height:100dvh;overflow:hidden}",
    });
  const shoot = async (name, themes = ["light"]) => {
    await clip();
    await page.evaluate(() => document.querySelector("vite-error-overlay")?.remove());
    await page.mouse.move(1, 1);
    for (const theme of themes) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const both = (name) => shoot(name, ["light", "dark"]);
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
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
    // The dev server may reload the page once as it bundles a module it hadn't seen.
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const go = (to, hash) =>
    page.evaluate(
      ([path, fragment]) =>
        window["__TSR_ROUTER__"].navigate({
          to: path,
          ...(fragment === undefined ? {} : { hash: fragment }),
        }),
      [to, hash],
    );
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const reread = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        predicate: (query) =>
          ["landings", "projects", "sessions"].includes(String(query.queryKey[0]?.[0])),
      }),
    );
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const dialog = () => page.getByRole("dialog").filter({ visible: true }).last();
  const closeDialog = async () => {
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "hidden" });
    await settled();
  };
  const hash = () => new URL(page.url()).hash;
  // After a landing origin refused (an earlier run on this stack), the same button reads Try again.
  const pushButton = () => dialog().getByRole("button", { name: /^(Push to origin|Try again)$/ });
  const section = (file) => visible(page.locator(`section[data-file="${file}"]`));

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The sessions the CLI batch made.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const sessions = rows
    .filter((row) => row.worktreeName === "land-retry")
    .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)))
    .map((row) => row.session);
  const owner = sessions[0];
  const editing = sessions.find((session) => session.status === "running");
  if (owner === undefined || editing === undefined)
    throw new Error("run land-sessions.json first: land-retry or its running session is missing");
  await client(
    async (trpc, labels) => {
      for (const [id, label] of labels) await trpc.sessions.setLabel.mutate({ id, label });
    },
    [
      [owner.id, TITLES.owner],
      [editing.id, TITLES.editing],
    ],
  );
  const me = await page.evaluate(
    () =>
      window["__TSR_ROUTER__"].options.context.queryClient
        .getQueryCache()
        .findAll({ queryKey: [["organization", "current"]] })[0]?.state.data?.userId,
  );
  if (typeof me !== "string") throw new Error("the page holds no signed-in account");
  // Start clean: no kept arrangement, and no description left from an earlier run.
  await page.context().clearCookies({ name: "mend-tiles" });
  await page.evaluate(() => sessionStorage.clear());

  // Land… in the toolbar, before anything landed.
  await open(`/sessions/${owner.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  await button("Land…").waitFor();
  note("the Change view's toolbar has Land… before anything landed");
  await both("toolbar-desktop");

  // The real dialog, another session still editing. A local stack's origin is its fetch-only git
  // fixture; a check VM's project comes from GitHub, where the dialog opens a pull request.
  await button("Land…").click();
  await dialog().getByRole("heading", { name: "Land change" }).waitFor();
  if (hash() !== "#land") throw new Error(`Land… opened ${page.url()}, not #land`);
  await dialog().getByText(`${TITLES.editing} is still editing`).waitFor();
  const noPullRequest = dialog().getByText(/^No pull request: /);
  const openPullRequest = dialog().getByRole("button", {
    name: "Push and open pull request",
  });
  await noPullRequest.or(openPullRequest).first().waitFor({ timeout: 30_000 });
  const realGitHub = (await openPullRequest.count()) > 0;
  if (!realGitHub) {
    await pushButton().waitFor();
    if ((await dialog().getByRole("textbox", { name: "Pull request title" }).count()) !== 0)
      throw new Error("a non-GitHub origin's dialog offers a pull request title");
    note(
      `the dialog on the stack: ${await noPullRequest.innerText()} · names "${TITLES.editing} is still editing" · ${await pushButton().innerText()}`,
    );
    await both("dialog-origin-desktop");

    // Land: the stack's git fixture serves fetches only, so origin refuses the push.
    await pushButton().click();
    const refused = dialog().getByRole("heading", {
      name: /refused the push|didn't finish/,
    });
    await refused.waitFor({ timeout: 180_000 });
    await dialog().getByRole("button", { name: "Try again" }).waitFor();
    note(
      `a real landing on the stack: "${await refused.innerText()}" · ${(await dialog().locator("pre").innerText()).slice(0, 160)}`,
    );
    await both("refused-origin-desktop");
    // Check origin reads origin's branch again, with this account's git access.
    await dialog().getByRole("button", { name: "Check origin" }).click();
    await dialog()
      .getByText(/^origin (could not be checked|not compared|has no |.* at )/)
      .waitFor({ timeout: 60_000 });
    note(
      `Check origin: ${await dialog()
        .getByText(/^origin (could not be checked|not compared|has no |.* at )/)
        .innerText()}`,
    );
  } else {
    // A real GitHub origin: its own controls, read for real. Nothing is pushed: a push here would
    // reach GitHub. The non-GitHub dialog and a push that goes through are laid as fixtures below.
    await dialog()
      .getByText(/opens a pull request on GitHub/)
      .waitFor();
    await dialog().getByRole("textbox", { name: "Pull request title" }).waitFor();
    await dialog().getByText("Pull request base").waitFor();
    if ((await noPullRequest.count()) !== 0)
      throw new Error("a GitHub origin's dialog says there is no pull request");
    const pushLine = (await dialog().getByRole("definition").first().innerText()).replace(
      /\s+/g,
      " ",
    );
    note(
      `the dialog on a GitHub origin: Push ${pushLine} · Pull request base · Pull request title · names "${TITLES.editing} is still editing" · Push and open pull request`,
    );
    await both("dialog-github-origin-desktop");
    // Check GitHub asks GitHub, as this account, for a pull request opened outside Mend: a read.
    // Its answer is a status, or an alert when the server can't ask (no GitHub account connected).
    await dialog().getByRole("button", { name: "Check GitHub" }).click();
    const checked = dialog()
      .getByRole("status")
      .or(dialog().getByRole("alert"))
      .filter({ hasText: /pull request|GitHub|github/ });
    await checked.first().waitFor({ timeout: 60_000 });
    note(`Check GitHub (real, a GitHub origin): ${await checked.first().innerText()}`);
    note(
      "differs · this origin is GitHub: the real push refused by a fetch-only origin and its Check origin are a local stack's; nothing was pushed",
    );
  }
  await closeDialog();
  if (hash() !== "") throw new Error("closing the dialog left #land in the address");

  // The workspace "…" opens the same dialog through the Change view.
  await go(`/sessions/${owner.id}`);
  await visible(page.locator(`[data-tab="session:${owner.id}"]`)).waitFor();
  await button("Workspace actions").click();
  await visible(page.getByRole("menuitem", { name: "Land…" })).click();
  await dialog().getByRole("heading", { name: "Land change" }).waitFor();
  if (!page.url().endsWith(`/sessions/${owner.id}/change#land`))
    throw new Error(`the workspace's Land… went to ${page.url()}`);
  note("the workspace '…' has Land…, which opens /sessions/<id>/change#land with the dialog");
  await closeDialog();

  // An old link: /changes/<id>#land.
  const changeId = await client(
    async (trpc, id) => (await trpc.sessions.detail.query({ id })).change?.id ?? null,
    owner.id,
  );
  if (changeId === null) throw new Error("land-retry has no change");
  await open(`/changes/${changeId}#land`);
  await dialog().getByRole("heading", { name: "Land change" }).waitFor({ timeout: 60_000 });
  note(`/changes/<id>#land opened ${new URL(page.url()).pathname}${hash()} with the dialog`);
  await closeDialog();

  // Fixtures from here: a GitHub origin and what landing there records.
  // The checkpoint the view shows ("main to checkpoint N"): the "landed" fixture landed it, the
  // "moved" one an earlier checkpoint.
  await open(`/sessions/${owner.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  const shown = Number(
    /to checkpoint (\d+)/.exec(await visible(page.getByText(/to checkpoint \d+/)).innerText())?.[1],
  );
  const detail = await client(async (trpc, id) => trpc.sessions.detail.query({ id }), owner.id);
  const checkpoints = detail.checkpoints.toSorted((a, b) => b.ordinal - a.ordinal);
  const newest = checkpoints.find((each) => each.ordinal === shown) ?? checkpoints[0];
  const earlier = checkpoints.find((each) => each.ordinal < newest.ordinal) ?? newest;
  const branch = detail.session.branch;
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const pullRequest = (state = "open") => ({
    number: 412,
    url: PR_URL,
    state,
    title: PR_TITLE,
    observedAt: at(1),
  });
  const landed = (checkpoint, fields = {}) => ({
    id: "fixture-landing-1",
    changeId,
    sessionId: owner.id,
    projectId: owner.projectId,
    checkpointId: checkpoint.id,
    checkpointRef: checkpoint.ref,
    checkpointSha: checkpoint.sha,
    commitSha: SHA,
    remoteBranch: branch,
    pushedSha: SHA,
    oneOff: false,
    trigger: "manual",
    pullRequest: pullRequest(),
    pullRequestCrossRepository: false,
    pullRequestHeadOwner: null,
    outcome: "pull-request",
    message: null,
    userId: me,
    // Recorded just after its checkpoint, as a landing is.
    createdAt: new Date(new Date(checkpoint.createdAt).getTime() + 1_000).toISOString(),
    ...fields,
  });
  const pushedFacts = [
    { _tag: "pushed", branch, sha: SHA },
    {
      _tag: "pull-request",
      number: 412,
      state: "open",
      observedAt: at(1),
      outside: false,
      fork: null,
    },
  ];
  const refusedLanding = {
    ...landed(newest, { id: "fixture-landing-2" }),
    pushedSha: null,
    commitSha: null,
    pullRequest: null,
    outcome: "refused",
    message: `remote: error: GH006: Protected branch update failed for refs/heads/${branch}.\nremote: error: You're not authorized to push to this branch.`,
  };
  const UNAVAILABLE = "pull request unavailable · origin is on verify-stack-fixture, not GitHub";
  const pushedOnly = {
    ...landed(newest, { id: "fixture-landing-3" }),
    pullRequest: null,
    outcome: "pushed",
  };
  const STATES = {
    // The stack's own origin, with a push that went through.
    origin: { landings: [], facts: [], github: false },
    pushed: {
      landings: [pushedOnly],
      facts: [{ _tag: "pushed", branch, sha: SHA }],
      github: false,
    },
    github: { landings: [], facts: [] },
    landed: { landings: [landed(newest)], facts: pushedFacts },
    moved: {
      landings: [landed(earlier)],
      facts: [...pushedFacts, { _tag: "changed-since-landing", files: 1 }],
    },
    refused: {
      landings: [refusedLanding],
      facts: [{ _tag: "refused", branch, message: refusedLanding.message }],
    },
  };
  const forChange = (kind) => {
    const { landings, facts, github = true } = STATES[kind];
    return superjson(
      {
        changeId,
        sessionId: owner.id,
        land: true,
        landings,
        facts,
        remote: null,
        remoteFailure: null,
        pullRequest: github
          ? { available: true, reason: null }
          : { available: false, reason: UNAVAILABLE },
        nextBranch: branch,
      },
      [
        ...landingDates(landings, "landings."),
        ...facts.flatMap((fact, index) =>
          fact._tag === "pull-request" ? [`facts.${index}.observedAt`] : [],
        ),
      ],
    );
  };
  // The owner's session as a conversation that landed, so the conversation shows the landing.
  const t1 = turn(
    owner.id,
    me,
    0,
    "completed",
    "Fix the duplicate charge on checkout retry.",
    at(30),
    at(28),
  );
  const conversation = history({
    turns: [t1],
    items: [
      item(t1.id, "assistant-message", "completed", at(28.5), at(28.5), {
        text: "After a 503 the retry wrapper sent the charge again without an idempotency key. I added a key built from the order id.",
      }),
    ],
  });
  // What Land answers while a fixture lays a landing over the page: nothing is pushed.
  const report = (kind) => {
    const landing = kind === "pushed" ? pushedOnly : landed(newest, { id: "fixture-landing-4" });
    return superjson(
      {
        landing,
        pullRequest:
          kind === "pushed"
            ? { _tag: "unavailable", reason: UNAVAILABLE }
            : { _tag: "opened", pullRequest: pullRequest() },
      },
      [
        "landing.createdAt",
        ...(landing.pullRequest === null ? [] : ["landing.pullRequest.observedAt"]),
        ...(kind === "pushed" ? [] : ["pullRequest.pullRequest.observedAt"]),
      ],
    );
  };
  let state = null;
  let landAnswer = null;
  let failLandings = false;
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    // The app's tRPC client sends every call as a POST: the inputs are in the body.
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const mine = paths.map((path, index) => {
      const input = inputs[String(index)]?.json;
      if (path === "landings.forChange" && failLandings) return "fail";
      if (path === "landings.land" && landAnswer !== null) return "land";
      if (state === null) return null;
      if (path === "landings.forChange" && input?.id === changeId && input?.probe !== true)
        return "landings";
      if (path === "projects.detail" && input?.id === owner.projectId) return "project";
      if (path === "sessions.detail" && input?.id === owner.id) return "detail";
      if (path.startsWith("sessions.history") && input?.id === owner.id) return "history";
      return null;
    });
    if (mine.every((each) => each === null)) return route.continue();
    // A fixture's landing never reaches the server.
    if (mine.every((each) => each === "land")) {
      const answer = { result: { data: report(landAnswer) } };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(url.searchParams.has("batch") ? paths.map(() => answer) : answer),
      });
    }
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    paths.forEach((path, index) => {
      const kind = mine[index];
      if (kind === "fail")
        answers[index] = {
          error: {
            json: {
              message: "The verify recipe failed this read on purpose.",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path },
            },
          },
        };
      else if (kind === "landings") answers[index] = { result: { data: forChange(state) } };
      else if (kind === "history") answers[index] = { result: { data: conversation[path] } };
      else if (
        kind === "project" &&
        STATES[state].github !== false &&
        answers[index]?.result?.data !== undefined
      ) {
        const data = structuredClone(answers[index].result.data);
        data.json.project.originUrl = "https://github.com/northwind/checkout-api.git";
        answers[index] = { result: { data } };
      } else if (kind === "detail" && answers[index]?.result?.data !== undefined) {
        const data = patchDetail(answers[index].result.data, {
          status: "completed",
          harness: "claude",
          dropAgent: true,
        });
        const { landings } = STATES[state];
        data.json.landings = landings;
        for (const key of Object.keys(data.meta.values))
          if (key.startsWith("landings.")) delete data.meta.values[key];
        for (const key of landingDates(landings, "landings.")) data.meta.values[key] = ["Date"];
        answers[index] = { result: { data } };
      }
    });
    await route.fulfill({
      response,
      status: failLandings ? 207 : response.status(),
      json: Array.isArray(body) ? answers : answers[0],
    });
  });
  const fixture = async (name) => {
    state = name;
    await reread();
    await settled();
  };

  const toast = (text) =>
    page.getByRole("region", { name: "Notifications" }).getByText(text).first();

  // A push that goes through, to an origin that isn't GitHub: the toast, the toolbar's line, and
  // the conversation's. The land answer is recorded: the stack's origin takes no push.
  await fixture("origin");
  await open(`/sessions/${owner.id}/change#land`);
  await dialog().getByRole("button", { name: "Push to origin" }).waitFor({ timeout: 60_000 });
  await dialog()
    .getByText(/^No pull request: /)
    .waitFor();
  note(
    `an origin that isn't GitHub (fixture): ${await dialog()
      .getByText(/^No pull request: /)
      .innerText()} · Push to origin`,
  );
  landAnswer = "pushed";
  state = "pushed";
  await dialog().getByRole("button", { name: "Push to origin" }).click();
  await toast(`Pushed ${branch} to origin.`).waitFor({ timeout: 30_000 });
  await dialog().waitFor({ state: "hidden" });
  const onOrigin = visible(page.getByText(`is on origin as ${branch}.`));
  await onOrigin.waitFor({ timeout: 30_000 });
  note(
    `a push that went through: the toast "Pushed ${branch} to origin.", the dialog closed, and "${await onOrigin.innerText()}"`,
  );
  await shoot("pushed-origin-desktop");
  landAnswer = null;
  await go(`/sessions/${owner.id}`);
  const pushedMark = visible(page.getByText(`pushed to origin as ${branch}`));
  await pushedMark.waitFor({ timeout: 30_000 });
  note(`the conversation: "${await pushedMark.innerText()}"`);

  // A GitHub origin: the title, your description, and the Preview of the whole description.
  await fixture("github");
  await open(`/sessions/${owner.id}/change#land`);
  await dialog().getByRole("textbox", { name: "Pull request title" }).waitFor({ timeout: 60_000 });
  await dialog().getByText("github.com/northwind/checkout-api").waitFor();
  const title = await dialog().getByRole("textbox", { name: "Pull request title" }).inputValue();
  if (title !== TITLES.owner)
    throw new Error(`the title starts as "${title}", not the session's label`);
  await dialog().getByRole("textbox", { name: "Pull request title" }).fill(PR_TITLE);
  await dialog().getByRole("textbox", { name: "Description" }).fill(DESCRIPTION);
  await dialog().getByRole("button", { name: "Push and open pull request" }).waitFor();
  note(
    "a GitHub origin: Push … to github.com/northwind/checkout-api, the pull request base, the title from the session's label, your description, Push and open pull request",
  );
  await both("dialog-desktop");
  await dialog()
    .getByRole("radio", { name: "Preview" })
    .or(dialog().getByRole("button", { name: "Preview" }))
    .click();
  const preview = dialog().getByRole("region", { name: "Description preview" });
  await preview.waitFor();
  await preview.getByText(DESCRIPTION).waitFor();
  await preview.getByRole("heading", { name: "In Mend" }).waitFor();
  note(
    `Preview shows your text, then Mend's section: ${(await preview.getByRole("heading").allInnerTexts()).join(" · ")}`,
  );
  await both("preview-desktop");
  // Closing keeps the draft: open it again and your words are there.
  await closeDialog();
  await button("Land…").click();
  await dialog().getByRole("textbox", { name: "Pull request title" }).waitFor();
  if ((await dialog().getByRole("textbox", { name: "Description" }).inputValue()) !== DESCRIPTION)
    throw new Error("closing the dialog lost the description");
  // Check GitHub is there before anything landed: it asks the server, which says why it can't look
  // (a status, or an alert when no GitHub account is connected).
  await dialog().getByRole("button", { name: "Check GitHub" }).click();
  const githubAnswer = dialog()
    .getByRole("status")
    .or(dialog().getByRole("alert"))
    .filter({
      hasText: /pull request|GitHub not checked|GitHub account|github/,
    })
    .first();
  await githubAnswer.waitFor({ timeout: 60_000 });
  note(`Check GitHub (real, this server's origin): ${await githubAnswer.innerText()}`);
  note("closing and opening the dialog keeps the title and description");

  // Land: the recorded answer opens pull request #412, and the dialog closes with a toast.
  landAnswer = "opened";
  state = "landed";
  await dialog().getByRole("button", { name: "Push and open pull request" }).click();
  await toast(`Pushed ${branch} and opened pull request #412.`).waitFor({
    timeout: 30_000,
  });
  await dialog().waitFor({ state: "hidden" });
  note(`Push and open pull request: the toast "Pushed ${branch} and opened pull request #412."`);
  landAnswer = null;

  // After landing: the toolbar names the pull request, and nothing is left to land.
  await fixture("landed");
  await page
    .getByText("is in pull request #412.")
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await visible(page.getByRole("link", { name: "Pull request #412 open" })).waitFor();
  if ((await page.getByRole("button", { name: /^Land/ }).filter({ visible: true }).count()) !== 0)
    throw new Error("a change with nothing new to land still offers Land…");
  note(
    `after landing: "${await page.getByText("is in pull request #412.").filter({ visible: true }).first().innerText()}" with the link Pull request #412 open, and no Land button`,
  );
  await both("landed-desktop");
  await button("What landed").click();
  await dialog().getByRole("heading", { name: "Pull request #412" }).waitFor();
  await dialog().getByRole("button", { name: "Refresh pull request" }).waitFor();
  await dialog().getByRole("button", { name: "Check origin" }).waitFor();
  note(
    "What landed: the pull request, what Mend observed, Check origin, Check GitHub, Refresh pull request",
  );
  await shoot("landed-dialog-desktop");
  await closeDialog();

  // The conversation: the landing after the checkpoint it landed.
  await go(`/sessions/${owner.id}`);
  const marker = visible(
    page.getByText(`Checkpoint ${newest.ordinal} landed as pull request #412`),
  );
  await marker.waitFor({ timeout: 30_000 });
  await visible(page.getByRole("link", { name: "View pull request" })).waitFor();
  note(
    `the conversation: "Checkpoint ${newest.ordinal} landed as pull request #412 · View pull request"`,
  );
  note(
    `conversation ARIA: ${(
      await visible(page.getByRole("log").or(page.locator("[data-slot=conversation]")))
        .ariaSnapshot()
        .catch(() => "")
    )
      .split("\n")
      .filter((line) => line.includes("landed as") || line.includes("View pull request"))
      .join(" | ")}`,
  );
  await shoot("conversation-landed-desktop");

  // More work since: the newer checkpoint isn't in the pull request, and Land again… updates it.
  await fixture("moved");
  await go(`/sessions/${owner.id}/change`);
  await visible(page.getByText(/isn't in pull request #412 yet\./)).waitFor({
    timeout: 30_000,
  });
  await button("Land again…").waitFor();
  note(
    `more work: "${await visible(page.getByText(/isn't in pull request #412 yet\./)).innerText()}" with Land again…`,
  );
  await both("land-again-desktop");
  await button("Land again…").click();
  await dialog().getByRole("heading", { name: "Update pull request #412" }).waitFor();
  const kept = await dialog().getByRole("textbox", { name: "Pull request title" }).inputValue();
  if (kept !== PR_TITLE)
    throw new Error(`the update's title reads "${kept}", not the pull request's`);
  await dialog()
    .getByText(/^Mend replaces only its own section/)
    .waitFor();
  await dialog().getByRole("button", { name: "Push and update pull request" }).waitFor();
  if ((await dialog().getByRole("textbox", { name: "Description" }).count()) !== 0)
    throw new Error("the update dialog has a description box");
  note(
    "Update pull request #412: the title kept as GitHub has it, Mend replaces only its own section, Push and update pull request",
  );
  await both("update-desktop");
  await closeDialog();

  // GitHub refused the push, in its own words.
  await fixture("refused");
  await go(`/sessions/${owner.id}/change`, "land");
  await dialog()
    .getByRole("heading", { name: "GitHub refused the push" })
    .waitFor({ timeout: 30_000 });
  await dialog()
    .locator("pre")
    .getByText(/GH006: Protected branch update failed/)
    .waitFor();
  await dialog().getByRole("button", { name: "Try again" }).waitFor();
  note("GitHub refused the push: its words, Nothing was pushed…, Try again");
  await both("refused-github-desktop");
  await closeDialog();

  // The phone: the dialog is a sheet; after more work the band holds Land again….
  await page.setViewportSize(PHONE);
  await fixture("github");
  await open(`/sessions/${owner.id}/change#land`);
  await dialog().getByRole("textbox", { name: "Pull request title" }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(600);
  note("on a phone the Land dialog is a sheet from the bottom, its buttons at the foot");
  await both("sheet-phone");
  await closeDialog();
  await fixture("moved");
  await visible(page.getByRole("button", { name: "Land again…" })).waitFor({
    timeout: 30_000,
  });
  await both("land-again-phone");
  await page.setViewportSize(DESKTOP);

  // A landing read that fails: Land… still opens the dialog, which says so with Try again.
  state = null;
  failLandings = true;
  await go("/no-such-page");
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await go(`/sessions/${owner.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  await button("Land…").click();
  await dialog().getByText("This didn't load.").waitFor({ timeout: 30_000 });
  await shoot("failed-desktop");
  failLandings = false;
  await dialog().getByRole("button", { name: "Try again" }).click();
  await (
    realGitHub ? dialog().getByRole("button", { name: "Push and open pull request" }) : pushButton()
  ).waitFor({ timeout: 30_000 });
  note("a landing read that fails says so in the dialog with Try again, which reads it again");
  await closeDialog();
  await page.unroute("**/trpc/**");

  // Leave the stack as it was: stop every session the batch left running here, drop the draft.
  const running = sessions.filter((session) => session.status === "running").map((each) => each.id);
  await client(async (trpc, ids) => {
    for (const id of ids) await trpc.sessions.stop.mutate({ id }).catch(() => undefined);
  }, running);
  await page.evaluate(() => sessionStorage.clear());
  note(`stopped the ${running.length} running session(s) in land-retry`);
};
