// A project's Access policy, its Brokered secrets and a worktree's pinned policy in the web app
// (W4-2, SLNT-1338): Project → Workspace's Access policy section, Project → Variables and secrets'
// Direct or Brokered delivery, and a session's Details (its runtime, its worktree's pinned policy
// and Apply updated policy).
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/access-policy-sessions.json
//   pnpm verify drive web --recipe project-access-policy
//
// The CLI batch starts one `sleep` session in a worktree `policy-ws-<time>` of verify-fixture, made
// under the project's policy then (Standard). Without it the recipe stops and says so. On the box,
// start that session in `<p>` (`M run --project <p> --name policy-ws-$(date +%s) --detach --
// sleep 7243`) and drive the recipe with `MAIN_RUN_PROJECT=<p>`.
//
// What is real and what is rewritten:
// - Real: two policies the recipe makes (one that caps Git, one that allows Brokered secrets, so
//   elevated), assigning one to the project and updating it from its template, the worktree's
//   Apply updated policy and its answer, a Brokered secret added in one write and made Direct, the
//   refusals before sending, and the phone layout.
// - Rewritten in the page: the signed-in read with `role: "member"`, for a member's owner gates
//   (an elevated policy they can't assign, a Brokered secret they can't turn back to Direct), and
//   one Apply answered with the server's refusal, for how the page shows it word for word.
//
// The recipe puts the project back on the policy it held and removes its secret and policies. The
// worktree keeps the rules it applied (a pin is the worktree's own); its session is the batch's.
import { FAKES } from "../scripts/fakes.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const SECRET = "VERIFY_BROKERED";
// The project the recipe works in: the stack's fixture, or the box's `<p>` (flows.md).
const PROJECT = process.env.MAIN_RUN_PROJECT ?? "verify-fixture";

const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");

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
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const dialog = (name) => visible(page.getByRole("dialog", { name }));
  const closed = (name) => page.getByRole("dialog", { name }).waitFor({ state: "hidden" });
  const toastSays = (words) =>
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText(words)
      .first()
      .waitFor({ state: "attached" });
  const section = (name) => visible(page.getByRole("region", { name, exact: true }));
  /** Every read of who is signed in answers as a member of the organization, until `unroute`. */
  const asMember = () =>
    page.route("**/trpc/**", async (route) => {
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
  const STANDARD = {
    mode: "standard",
    allowHosts: [],
    gitTransport: "read-write",
    allowExecutorTools: true,
    allowBrokeredSecrets: false,
    requireVmIsolation: false,
    allowedPrivateEgress: [],
  };

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");

  const project = (await call("projects.list")).find((p) => p.name === PROJECT);
  expect(`${PROJECT} is adopted`, project !== undefined, "");
  // What the project holds now, to put back at the end.
  const original = (await call("accessPolicies.project", { projectId: project.id })).policy.source;
  note(`${PROJECT} holds a copy of ${original.name} at revision ${original.revision}`);
  // The session the CLI batch started, in the newest policy-ws worktree.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  const live = (rows ?? [])
    .filter(
      (row) =>
        /^policy-ws-\d+$/.test(row.worktreeName ?? "") &&
        !["completed", "stopped", "failed"].includes(row.session.status),
    )
    .toSorted((a, b) => String(a.worktreeName).localeCompare(String(b.worktreeName)));
  const session = live.at(-1)?.session;
  if (session === undefined)
    throw new Error("no running policy-ws session: run the CLI batch access-policy-sessions.json");
  note(`session ${session.id} in worktree ${live.at(-1).worktreeName}`);

  // Policies and a secret an earlier run left go first.
  for (const left of (await call("accessPolicies.list")).policies.filter((p) =>
    /^Verify (git|keys) [a-z0-9]{4}$/.test(p.name),
  ))
    await call("accessPolicies.remove", { id: left.id }, "mutate").catch(() => undefined);
  const leftSecret = (await call("environment.secrets", { projectId: project.id })).secrets.find(
    (secret) => secret.name === SECRET,
  );
  if (leftSecret !== undefined)
    await call(
      "environment.removeSecret",
      {
        projectId: project.id,
        secretId: leftSecret.id,
        request: { expectedRevision: leftSecret.revision },
      },
      "mutate",
    ).catch(() => undefined);

  const tag = Math.random().toString(36).slice(2, 6);
  const made = [];
  const create = async (name, rules) => {
    const outcome = await call("accessPolicies.create", { name, rules }, "mutate");
    expect(`made ${name}`, outcome.ok, outcome);
    made.push(outcome.result.id);
    return outcome.result;
  };
  const git = await create(`Verify git ${tag}`, {
    ...STANDARD,
    gitTransport: "read-only",
    allowExecutorTools: false,
  });
  const keys = await create(`Verify keys ${tag}`, { ...STANDARD, allowBrokeredSecrets: true });
  note(`made ${git.name} (Git fetch only, no Executor tools) and ${keys.name} (elevated)`);
  const workspace = `/projects/${project.id}/settings/workspace`;
  const secretsPage = `/projects/${project.id}/settings/secrets`;

  try {
    // --- Project → Workspace: Standard, then Change policy… ---------------------------------------
    await navigate(workspace);
    await heading("Workspace");
    const policy = () => section("Access policy");
    await visible(policy().getByText(/^A copy of /)).waitFor();
    note(`the section names ${PROJECT}'s copy of ${original.name}`);
    await both("project-access-policy-standard-desktop");
    await policy().getByRole("button", { name: "Change policy…", exact: true }).click();
    const choose = dialog(`Access policy for ${PROJECT}`);
    await visible(choose.getByText(/New worktrees start with the copy/)).waitFor();
    await visible(choose.getByText(keys.name, { exact: false })).waitFor();
    note(
      "the dialog lists every policy, marks the elevated one, and says worktrees keep their rules",
    );
    await both("project-access-policy-choose-desktop");
    await choose.getByRole("radio", { name: new RegExp(`^${git.name}`) }).click();
    await choose.getByRole("button", { name: "Assign policy", exact: true }).click();
    await toastSays(`${git.name} is copied into this project.`);
    await closed(`Access policy for ${PROJECT}`);
    await visible(policy().getByText(`A copy of ${git.name} at revision 1, its latest.`)).waitFor();
    await visible(policy().getByText("Fetch only")).waitFor();
    note(`assigned ${git.name}: the section shows its copy, Git fetch only`);
    await both("project-access-policy-assigned-desktop");

    // --- Update from template ---------------------------------------------------------------------
    await call(
      "accessPolicies.update",
      {
        id: git.id,
        request: {
          name: git.name,
          rules: { ...git.rules, gitTransport: "disabled" },
          expectedRevision: git.revision,
        },
      },
      "mutate",
    );
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(workspace);
    await heading("Workspace");
    await visible(policy().getByText(/is at revision 2 now/)).waitFor();
    note(
      `${git.name} moved to revision 2 (Git off); the project keeps revision 1 and offers the update`,
    );
    await shot("project-access-policy-newer-desktop-light");
    await policy().getByRole("button", { name: "Update from template", exact: true }).click();
    await visible(policy().getByText(`A copy of ${git.name} at revision 2, its latest.`)).waitFor();
    note("Update from template copied revision 2");

    // --- A member: the elevated policy says it takes an owner -------------------------------------
    await asMember();
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(workspace);
    await heading("Workspace");
    await policy().getByRole("button", { name: "Change policy…", exact: true }).click();
    const member = dialog(`Access policy for ${PROJECT}`);
    await visible(member.getByText(/only an Organization Owner can assign it/)).waitFor();
    const elevatedRadio = member.getByRole("radio", { name: new RegExp(`^${keys.name}`) });
    expect("a member can't pick the elevated policy", await elevatedRadio.isDisabled(), "");
    note(
      "as a member (rewritten read), the elevated policy is off with who can assign it, before anyone presses Assign",
    );
    await shot("project-access-policy-member-desktop-light");
    await page.keyboard.press("Escape");
    await page.unroute("**/trpc/**");
    await clearCache();

    // --- The worktree's Details: its runtime, its pin, Apply updated policy -----------------------
    const details = `/sessions/${session.id}/details`;
    await open(details);
    const group = () => section("Access policy");
    await visible(group().getByText(/^Standard, revision 1, pinned/)).waitFor();
    const runtimeLine = await visible(
      page.getByRole("region", { name: "Workspace", exact: true }),
    ).innerText();
    expect("the runtime line never says isolated", !/isolat/i.test(runtimeLine), runtimeLine);
    note(`Workspace group: ${runtimeLine.replace(/\s+/g, " ").slice(0, 300)}`);
    await visible(
      group().getByText(/The project's policy changed since this worktree pinned/),
    ).waitFor();
    note(
      "the worktree still runs on Standard; the project's policy differs, so Apply updated policy shows",
    );
    await both("project-access-policy-details-desktop");

    // One Apply answered with the server's refusal, to show it word for word.
    const refusal =
      "workspace ws-verify runs no egress proxy now, so it would take the new rules only when it starts again. Stop the worktree's sessions, apply the policy, then start one.";
    await page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes("accessPolicies.applyUpdated")) return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          paths.map(() => ({
            result: { data: { json: { ok: false, kind: "not-applied", message: refusal } } },
          })),
        ),
      });
    });
    await group().getByRole("button", { name: "Apply updated policy", exact: true }).click();
    await visible(group().getByText(`Not applied. ${refusal}`)).waitFor();
    note("a refused Apply (rewritten answer) shows the server's words: stop, apply, then start");
    await shot("project-access-policy-not-applied-desktop-light");
    await page.unroute("**/trpc/**");

    await group().getByRole("button", { name: "Apply updated policy", exact: true }).click();
    // The session runs on Docker with no proxy, and the new rules (Git, Executor tools) are ones
    // Mend holds to itself, so Apply must re-pin it; a refusal here is a failure.
    await visible(group().getByText(`Applied ${git.name}, revision 2.`, { exact: false })).waitFor({
      timeout: 60_000,
    });
    const pinned = (await call("accessPolicies.worktree", { id: session.worktreeId })).pin;
    expect(
      "the worktree took the project's policy",
      pinned?.source.policyId === git.id && pinned.source.revision === 2,
      pinned?.source,
    );
    await visible(group().getByText(`${git.name}, revision 2, pinned`, { exact: false })).waitFor();
    note(
      `Apply updated policy, for real: ${(await group().innerText()).replace(/\s+/g, " ").slice(0, 400)}`,
    );
    await both("project-access-policy-applied-desktop");

    // --- Variables and secrets: a Brokered secret in one write ------------------------------------
    await open(secretsPage);
    await heading("Variables and secrets");
    await button("Add secret…").click();
    const add = dialog("Add secret");
    await add.getByLabel("Name", { exact: true }).fill(SECRET);
    await add.getByRole("button", { name: "Brokered", exact: true }).click();
    await add.getByLabel("Hosts", { exact: true }).fill("*.vercel.com");
    await visible(add.getByText(/Sessions won't start\./)).waitFor();
    note(
      `with ${git.name} (no Brokered secrets) assigned, choosing Brokered warns that sessions won't start`,
    );
    await both("project-access-policy-brokered-blocked-desktop");
    await typeSecret(add.getByLabel("Value", { exact: true }), "project-secret", FAKES.github);
    await add.getByRole("button", { name: "Add secret", exact: true }).click();
    await visible(add.getByText(/bindHosts/)).waitFor();
    note("a wildcard host is refused before sending, naming the rule");
    await add.getByLabel("Hosts", { exact: true }).fill("api.vercel.com");
    await add.getByRole("button", { name: "Add secret", exact: true }).click();
    await toastSays(`Added ${SECRET}.`);
    await closed("Add secret");
    const secrets = visible(page.getByRole("list", { name: "Secrets", exact: true }));
    await visible(secrets.getByText("Brokered to api.vercel.com")).waitFor();
    const stored = (await call("environment.secrets", { projectId: project.id })).secrets.find(
      (secret) => secret.name === SECRET,
    );
    expect("stored Brokered in one write", stored?.delivery.mode === "brokered", stored?.delivery);
    note(
      `${SECRET} added Brokered in one write: Authorization to api.vercel.com, placeholder only`,
    );
    await visible(
      page.getByText(new RegExp(`no session in ${PROJECT} starts while a secret here is Brokered`)),
    ).waitFor();
    await both("project-access-policy-secrets-desktop");

    // A member can't turn it back to Direct; Save stays off and says why.
    await asMember();
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(secretsPage);
    await heading("Variables and secrets");
    await button(`Delivery ${SECRET}`).click();
    const memberDelivery = dialog(`Delivery of ${SECRET}`);
    await memberDelivery.getByRole("button", { name: "Direct", exact: true }).click();
    await visible(memberDelivery.getByText(/Only an owner can save this\./)).waitFor();
    expect(
      "Save delivery is off for a member",
      await memberDelivery.getByRole("button", { name: "Save delivery", exact: true }).isDisabled(),
      "",
    );
    note(
      "as a member (rewritten read), Brokered → Direct says it takes an Organization Owner, and Save is off",
    );
    await shot("project-access-policy-owner-gate-desktop-light");
    await page.keyboard.press("Escape");
    await page.unroute("**/trpc/**");
    await clearCache();

    // An owner may.
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(secretsPage);
    await heading("Variables and secrets");
    await button(`Delivery ${SECRET}`).click();
    const ownerDelivery = dialog(`Delivery of ${SECRET}`);
    await ownerDelivery.getByRole("button", { name: "Direct", exact: true }).click();
    await ownerDelivery.getByRole("button", { name: "Save delivery", exact: true }).click();
    await toastSays(`${SECRET} is Direct.`);
    await visible(
      page.getByRole("list", { name: "Secrets", exact: true }).getByText("Direct", { exact: true }),
    ).waitFor();
    note(`as the owner, ${SECRET} went back to Direct`);

    // --- The phone ----------------------------------------------------------------------------------
    await page.setViewportSize(PHONE);
    await open(workspace);
    await visible(page.getByRole("heading", { name: "Workspace" })).waitFor();
    await visible(
      page.getByRole("region", { name: "Access policy", exact: true }),
    ).scrollIntoViewIfNeeded();
    await both("project-access-policy-phone");
    await open(secretsPage);
    await visible(page.getByRole("heading", { name: "Variables and secrets" })).waitFor();
    await both("project-access-policy-secrets-phone");
    await open(details);
    await visible(
      page.getByRole("region", { name: "Access policy", exact: true }),
    ).scrollIntoViewIfNeeded();
    await both("project-access-policy-details-phone");
    await page.setViewportSize(DESKTOP);
  } finally {
    await page.unroute("**/trpc/**").catch(() => undefined);
    // Back to the template it held (its latest revision), or Standard when that was removed.
    const restore = (policyId) =>
      call("accessPolicies.assign", { projectId: project.id, request: { policyId } }, "mutate");
    const back = await restore(original.policyId).catch(() => null);
    if (back === null || back.ok !== true) await restore("standard").catch(() => undefined);
    const secret = (
      await call("environment.secrets", { projectId: project.id }).catch(() => ({
        secrets: [],
      }))
    ).secrets.find((each) => each.name === SECRET);
    if (secret !== undefined)
      await call(
        "environment.removeSecret",
        {
          projectId: project.id,
          secretId: secret.id,
          request: { expectedRevision: secret.revision },
        },
        "mutate",
      ).catch(() => undefined);
    for (const id of made)
      await call("accessPolicies.remove", { id }, "mutate").catch(() => undefined);
    note(`put ${PROJECT} back on ${original.name}, removed its secret and the two policies`);
  }
};
