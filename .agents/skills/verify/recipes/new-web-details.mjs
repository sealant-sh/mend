// The Details view (apps/web, route PR 22, SLNT-1153, ADR 0026): a session's workspace, checks,
// Services and the sessions in it, opened as a tab like any other view, from its address
// (`/sessions/<id>/details`) and from a tile's "+". Run the CLI batch first, once per stack: it
// starts two sessions in one worktree `details-ws-<time>`, the first declaring a `web` Service in
// `.mend/mend.toml`.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-details-sessions.json
//   pnpm verify drive new-web --recipe new-web-details
//
// Real: the Workspace group with "Shared with 1 other session" (which moves focus to the sessions),
// the branch and base, "None yet" for the pull request, the Checks group's empty line, the
// running `web` Service, the two sessions with their owner, agent and status, and shared control:
// who holds it, whose login a steered turn spends (`who-pays`), and the switch for everyone an
// older client turned on, turned off from the row. Then Details opened from another session's
// tile "+".
//
// A local stack has no pull request, handoff, second repository, agent model, checks, per-person
// workspace or second member: those lines are drawn from fixture answers to the session's reads
// (captures named `fixture-…`): `model-shown`, `shared-workspace-line`, `layout-fallback`,
// `repo-session-card`, `handoff-row`, `land-session-line`, `viewer-lines`, `org-owner-off`, and
// shared control granted to the viewer alone. Preview, beside the running Service, opens the
// Preview view's tab. Last, a pull request read that fails, with Try again.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { command, history, item, superjson, turn } from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE_A = "Fix flaky checkout retry";
const TITLE_B = "Write tests for retry";
const GRACE = "fixture-grace";

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const capture = async (name) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Every signed-in page overflows by 2px while it settles: clip the sidebar's wrapper, and
      // park the mouse, so the driver keeps the picture.
      await page.evaluate(() => {
        const wrapper = document.querySelector("[data-slot=sidebar-wrapper]");
        if (wrapper instanceof HTMLElement) wrapper.style.maxHeight = "100dvh";
        document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove());
      });
      await page.mouse.move(2, 2);
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(500);
    }
  };
  const settled = () => page.waitForTimeout(500);
  const shoot = async (name, themes = ["light", "dark"]) => {
    for (const theme of themes) {
      await page.evaluate(
        (on) => document.documentElement.classList.toggle("dark", on),
        theme === "dark",
      );
      await settled();
      await capture(`${name}-${theme}`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href]")].some((link) =>
        Object.keys(link).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  /** Moves to `path` through the router: fixtures don't survive a full reload. */
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ to }), path);
  const reread = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries());
  const tabOf = (key) =>
    page.locator(`[data-tab="${key}"]`).filter({ visible: true }).getByRole("tab");
  const tileOf = (key) =>
    page.locator("[data-tile]").filter({ has: page.locator(`[data-tab="${key}"]`) });
  const group = (name) =>
    page.getByRole("region", { name, exact: true }).filter({ visible: true }).first();
  const textOf = async (name) => (await group(name).innerText()).replace(/\s+/g, " ").trim();

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await hydrated();

  // The two sessions the CLI batch started in the newest details worktree.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  const live = rows.filter(
    (row) =>
      /^details-ws-\d+$/.test(row.worktreeName ?? "") &&
      !["completed", "stopped", "failed"].includes(row.session.status),
  );
  const worktree = live
    .map((row) => row.worktreeName)
    .toSorted()
    .at(-1);
  const inWorktree = live
    .filter((row) => row.worktreeName === worktree)
    .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)));
  if (inWorktree.length < 2)
    throw new Error("a details-ws worktree needs two running sessions: run the CLI batch");
  const [A, B] = [inWorktree[0].session, inWorktree[1].session];
  const me = A.ownerUserId;
  note(`worktree ${worktree}: A ${A.id}, B ${B.id}`);
  await client(
    async (trpc, labels) => {
      for (const [id, label] of labels) await trpc.sessions.setLabel.mutate({ id, label });
    },
    [
      [A.id, TITLE_A],
      [B.id, TITLE_B],
    ],
  );

  // The workspace's `web` Service, from the recipe its mend.toml declares.
  const started = await client(
    async (trpc, id) =>
      trpc.sessions.runServiceRecipe
        .mutate({ id, name: "web" })
        .then(() => "started")
        .catch((error) => `refused: ${error.message}`),
    A.id,
  );
  note(`web Service: ${started}`);
  await page
    .waitForFunction(
      async (id) => {
        const { trpcClient } = window["__TSR_ROUTER__"].options.context;
        const views = await trpcClient.services.list.query({ all: true });
        return views.some(
          (view) => view.service.sessionId === id && view.currentForward?.state === "bound",
        );
      },
      A.id,
      { timeout: 60_000, polling: 1_000 },
    )
    .catch(() => note("web Service: its port didn't bind within 60s"));

  // Fixture answers, laid over the real reads while `state` is set.
  let state = null;
  const at = "2026-11-18T10:31:00.000Z";
  const patchDetail = (data) => {
    const json = structuredClone(data.json);
    const values = { ...data.meta?.values };
    json.session.harness = "claude";
    json.session.model = "claude-opus-5-5";
    json.session.effort = "high";
    json.session.livePeople = [
      { accountId: me, name: "Ada Lovelace" },
      { accountId: GRACE, name: "Grace Hopper" },
    ];
    json.session.summary =
      "this image cannot run per-person users (no sudo), so this workspace takes one person";
    json.session.ownerUserId = GRACE;
    const everyone = state === "full";
    json.session.sharedControlEnabledAt = everyone ? at : null;
    if (everyone) values["session.sharedControlEnabledAt"] = ["Date"];
    else delete values["session.sharedControlEnabledAt"];
    // Granted one by one: the viewer holds a grant (docs/adr/0026, decision 7).
    json.session.sharedControlUserIds = state === "granted" ? [me] : [];
    json.control = {
      ...json.control,
      own: false,
      toggleSharedControl: everyone,
      turnsOnSendersLogin: true,
    };
    json.repositories = [
      {
        repository: {
          id: "fixture-repository",
          sessionId: A.id,
          projectId: A.projectId,
          worktreeId: A.worktreeId,
          name: "payments",
          path: "vendor/payments",
          branch: "mend/fix-checkout-retry",
          baseSha: "9c41e07aa1b2c3d4e5f60718293a4b5c6d7e8f90",
          baseRef: "main",
          state: "ready",
          error: null,
          capture: "own",
          source: "added",
          addedByUserId: me,
          createdAt: at,
          updatedAt: at,
          readyAt: at,
        },
        projectName: "payments",
        change: { id: "fixture-change-payments" },
        checkpointsBeyondStart: 2,
      },
    ];
    return { json, meta: { ...data.meta, values } };
  };
  const landings = () =>
    superjson(
      {
        changeId: "fixture-change",
        sessionId: A.id,
        land: false,
        landings: [
          {
            id: "fixture-landing",
            changeId: "fixture-change",
            sessionId: A.id,
            projectId: A.projectId,
            checkpointId: null,
            checkpointRef: null,
            checkpointSha: null,
            commitSha: "4f2a91c0ffee4f2a91c0ffee4f2a91c0ffee4f2a",
            remoteBranch: "mend/fix-checkout-retry",
            pushedSha: "4f2a91c0ffee4f2a91c0ffee4f2a91c0ffee4f2a",
            oneOff: false,
            trigger: "owner",
            pullRequest: {
              number: 412,
              url: "https://github.com/sealant-sh/verify-fixture/pull/412",
              state: "open",
              title: null,
              observedAt: at,
            },
            pullRequestCrossRepository: false,
            pullRequestHeadOwner: null,
            outcome: "pull-request",
            message: null,
            userId: GRACE,
            createdAt: at,
          },
        ],
        facts: [
          {
            _tag: "pushed",
            branch: "mend/fix-checkout-retry",
            sha: "4f2a91c0ffee4f2a91c0ffee4f2a91c0ffee4f2a",
          },
          {
            _tag: "pull-request",
            number: 412,
            state: "open",
            observedAt: at,
            outside: false,
            fork: null,
          },
        ],
        remote: null,
        remoteFailure: null,
        pullRequest: null,
        nextBranch: "mend/fix-checkout-retry",
      },
      ["landings.0.pullRequest.observedAt", "landings.0.createdAt", "facts.1.observedAt"],
    );
  const conversation = () => {
    const t = turn(A.id, me, 0, "completed", "Fix the flaky checkout retry.", at, at);
    return history({
      turns: [t],
      items: [
        command(
          t.id,
          "completed",
          "2026-11-18T10:20:00.000Z",
          "2026-11-18T10:21:00.000Z",
          "pnpm test",
        ),
        command(
          t.id,
          "failed",
          "2026-11-18T10:22:00.000Z",
          "2026-11-18T10:22:30.000Z",
          "pnpm typecheck",
        ),
        item(
          t.id,
          "file-change",
          "completed",
          "2026-11-18T10:25:00.000Z",
          "2026-11-18T10:25:00.000Z",
          {
            title: "Edit src/retry.ts",
          },
        ),
        item(
          t.id,
          "file-change",
          "completed",
          "2026-11-18T10:26:00.000Z",
          "2026-11-18T10:26:00.000Z",
          {
            title: "Edit src/backoff.ts",
          },
        ),
      ],
    });
  };
  const failure = {
    error: {
      json: {
        message: "The verify recipe failed this read on purpose.",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    },
  };
  await page.route("**/trpc/**", async (route) => {
    if (state === null) return route.fallback();
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const answerOf = (path, index) => {
      const id = inputs[String(index)]?.json?.id;
      if (state === "failed")
        return path === "landings.forSession" && id === A.id ? { error: failure.error } : null;
      if (path === "sessions.detail" && id === A.id) return "detail";
      if (path === "landings.forSession" && id === A.id) return { result: { data: landings() } };
      if (path === "projects.detail") return "project";
      if (path === "organization.members") return "members";
      if (path.startsWith("sessions.history") && id === A.id)
        return { result: { data: conversation()[path] } };
      return null;
    };
    const mine = paths.map(answerOf);
    if (mine.every((each) => each === null)) return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    paths.forEach((_, index) => {
      const answer = mine[index];
      const data = answers[index]?.result?.data;
      if (answer === null) return;
      if (typeof answer === "object") answers[index] = answer;
      else if (data === undefined) return;
      else if (answer === "detail") answers[index] = { result: { data: patchDetail(data) } };
      else if (answer === "project") {
        const json = structuredClone(data.json);
        for (const each of json.worktrees ?? [])
          if (each.id === A.worktreeId) each.handoff = { ...each.handoff, machine: "ada-laptop" };
        answers[index] = { result: { data: { ...data, json } } };
      } else if (answer === "members") {
        const json = structuredClone(data.json);
        const first = json[0];
        if (first !== undefined) json.push({ ...first, userId: GRACE, name: "Grace Hopper" });
        answers[index] = { result: { data: { ...data, json } } };
      }
    });
    await route.fulfill({ response, json: Array.isArray(body) ? answers : answers[0] });
  });

  // From its address: /sessions/<A>/details opens the Details tab, focused.
  await page.context().clearCookies({ name: "mend-tiles" });
  await go(`/sessions/${A.id}/details`);
  await tabOf("view:details").waitFor();
  await group("Workspace").waitFor();
  await group("Services")
    .getByText("web :8000")
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  const selected = await tabOf("view:details").getAttribute("aria-selected");
  note(`/sessions/<A>/details: the Details tab shows, aria-selected=${selected}`);
  for (const name of ["Workspace", "Checks", "Services", "Sessions in this workspace"])
    note(`${name}: ${await textOf(name)}`);
  await shoot("details");
  await page.setViewportSize(PHONE);
  await settled();
  await shoot("phone-details");
  await page.setViewportSize(DESKTOP);
  await settled();

  // "Shared with 1 other session" takes the keyboard to the sessions in the workspace.
  await group("Workspace").getByRole("button", { name: "Shared with 1 other session" }).click();
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
  note(`Shared with 1 other session: focus is on "${focused}"`);

  // Shared control (route PR 34): the owner's row says who holds it and whose login a steered turn
  // spends. It goes to the person who asked, so the row never turns it on for everyone; the switch
  // for everyone that older clients turn on (here through the API) is turned off from the row.
  const sessions = group("Sessions in this workspace");
  note(`who-pays beside the row: ${await sessions.getByText(/^Each turn runs on/).innerText()}`);
  await sessions.getByText("Shared control is off.").first().waitFor();
  if ((await sessions.getByRole("button", { name: /^Turn on/ }).count()) > 0)
    throw new Error("the row offers to turn shared control on for everyone");
  await client(
    async (trpc, id) => trpc.sessions.setSharedControl.mutate({ id, enabled: true }),
    A.id,
  );
  await reread();
  const turnOff = sessions.getByRole("button", { name: "Turn off shared control" });
  await turnOff.waitFor({ timeout: 30_000 });
  note(`on for everyone (from an older client): ${await textOf("Sessions in this workspace")}`);
  await shoot("shared-on", ["light"]);
  await turnOff.click();
  // The button reads Turning off… while it runs: wait for the server, not for its name to change.
  let off = null;
  for (let tries = 0; tries < 30; tries += 1) {
    off = await client(async (trpc, id) => trpc.sessions.detail.query({ id }), A.id);
    if (off.session.sharedControlEnabledAt === null) break;
    await page.waitForTimeout(500);
  }
  if (off?.session.sharedControlEnabledAt !== null)
    throw new Error("Turn off shared control left the switch for everyone on");
  await turnOff.waitFor({ state: "detached" });
  note(
    `after Turn off shared control: sharedControlEnabledAt=${off.session.sharedControlEnabledAt}`,
  );

  // Preview, beside a running Service, opens the Preview view's tab.
  const previewLink = group("Services").getByRole("link", { name: "Preview" });
  if ((await previewLink.count()) === 0) note("Services: no Preview link");
  else {
    await previewLink.first().click();
    await tabOf("view:preview").waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-tab="view:preview"] [role="tab"]')
          ?.getAttribute("aria-selected") === "true",
    );
    note(`Preview: ${new URL(page.url()).pathname} · the Preview tab is selected`);
    await go(`/sessions/${A.id}/details`);
    await group("Workspace").waitFor();
  }

  // From a tile's "+": B's page, then Details from its tile's menu.
  await page.context().clearCookies({ name: "mend-tiles" });
  await go(`/sessions/${B.id}`);
  await tabOf(`session:${B.id}`).waitFor();
  await tileOf(`session:${B.id}`).getByRole("button", { name: "Open a view" }).click();
  await page.getByRole("menuitem", { name: /^Details/ }).waitFor();
  const menuItems = await page.getByRole("menuitem").allInnerTexts();
  note(`+ menu: ${menuItems.map((each) => each.trim()).join(" | ")}`);
  await shoot("open-menu", ["light"]);
  await page.getByRole("menuitem", { name: /^Details/ }).click();
  await tabOf("view:details").waitFor();
  await group("Workspace").waitFor();
  note(
    `+ → Details: tab aria-selected=${await tabOf("view:details").getAttribute("aria-selected")}`,
  );

  // Fixtures: a session another member owns and shares, with a pull request, a handoff, a second
  // repository, checks and edits since, a model, a per-person workspace and a layout fallback.
  await go("/no-such-page");
  state = "full";
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await page.context().clearCookies({ name: "mend-tiles" });
  await go(`/sessions/${A.id}/details`);
  await group("Workspace").getByText("Pull request #412 open").waitFor({ timeout: 30_000 });
  await group("Checks").getByText("pnpm typecheck").waitFor({ timeout: 30_000 });
  for (const name of ["Workspace", "Checks", "Repositories", "Sessions in this workspace"])
    note(`fixture ${name}: ${await textOf(name)}`);
  await shoot("fixture-full");
  await page.setViewportSize(PHONE);
  await settled();
  await shoot("phone-fixture-full", ["light"]);
  await page.setViewportSize(DESKTOP);
  await settled();

  // The same session while shared control is off: a member reads who steers.
  state = "member-off";
  await reread();
  await group("Sessions in this workspace")
    .getByText(/^Only Grace Hopper steers/)
    .waitFor();
  note(`member, off: ${await textOf("Sessions in this workspace")}`);
  await shoot("fixture-member-off", ["light"]);

  // The viewer holds shared control, granted to them alone.
  state = "granted";
  await reread();
  await group("Sessions in this workspace")
    .getByText(/shares control of this session with you/)
    .waitFor();
  note(`granted to the viewer: ${await textOf("Sessions in this workspace")}`);
  await shoot("fixture-granted", ["light"]);

  // A pull request read that fails, with Try again.
  await go("/no-such-page");
  state = "failed";
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await go(`/sessions/${A.id}/details`);
  await group("Workspace").getByText("This didn't load.").waitFor({ timeout: 30_000 });
  await shoot("pull-request-failed", ["light"]);
  state = null;
  await group("Workspace").getByRole("button", { name: "Try again" }).click();
  await group("Workspace").getByText("None yet").waitFor({ timeout: 30_000 });
  note("pull request read failed: This didn't load. · Try again read it again: None yet");
  await page.unroute("**/trpc/**");
};
