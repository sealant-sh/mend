// A project's cluster bindings on its Variables and secrets page in the web app (route PR 55,
// SLNT-1171): only where the server runs workspaces on Kubernetes.
//
//   pnpm verify drive web --recipe project-cluster-bindings
//
// Feature ids (cluster-bindings.md): `cluster-bind-web`, `cluster-remove`,
// `cluster-service-account`, `cluster-local-runner`.
//
// What is real and what is rewritten:
// - Real: verify-fixture's page on the stack, which runs workspaces on its local runner with
//   nothing bound: the section isn't there.
// - Rewritten (a local stack has no Kubernetes): the bindings read, as a Kubernetes server answers
//   it, and the binds, removals and service account writes, answered as the server would (a
//   duplicate refused in its shape); then the same read on a server without Kubernetes that still
//   has a binding. `lib/cluster-bindings.test.ts` holds the mapping from read to section.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const at = "2026-11-19T07:00:00.000Z";

const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");

/** One tRPC answer, with the superjson meta that turns the timestamps into dates. */
const dated = (json) => ({
  result: {
    data: {
      json,
      meta: {
        values: Object.fromEntries(
          (json.bindings ?? []).flatMap((_, index) => [
            [`bindings.${index}.createdAt`, ["Date"]],
            [`bindings.${index}.updatedAt`, ["Date"]],
          ]),
        ),
      },
    },
  },
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
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const section = () => visible(page.getByRole("region", { name: "Cluster bindings" }));
  const toastSays = (words) =>
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText(words)
      .first()
      .waitFor({ state: "attached" });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const fixture = (await call("projects.list")).find(
    (project) => project.name === "verify-fixture",
  );
  expect("the stack's verify-fixture project", fixture !== undefined, "");
  const home = `/projects/${fixture.id}/settings/secrets`;

  // --- Real: a local runner with nothing bound shows no section ------------------------------
  const real = await call("environment.clusterBindings", { projectId: fixture.id });
  note(
    `the real read: clusterCapable ${real.clusterCapable}, ${real.bindings.length} bindings, service account ${real.serviceAccount}`,
  );
  await navigate(home);
  await heading("Variables and secrets");
  await page.waitForTimeout(1_500);
  const shown = await page.getByRole("region", { name: "Cluster bindings" }).count();
  expect("no Cluster bindings on a local runner with nothing bound", shown === 0, shown);
  note("cluster-local-runner: on this stack (local runner, nothing bound) the section isn't shown");

  // --- Rewritten: a Kubernetes server --------------------------------------------------------
  const binding = (id, kind, objectName) => ({
    id,
    projectId: fixture.id,
    kind,
    objectName,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
  let state = {
    revision: 1,
    bindings: [binding("cb-1", "secret", "app-env"), binding("cb-2", "configmap", "feature-flags")],
    serviceAccount: null,
    clusterCapable: true,
  };
  const answers = {
    "environment.clusterBindings": () => dated(state),
    "environment.addClusterBinding": (input) => {
      const request = input?.request ?? {};
      if (
        state.bindings.some((b) => b.kind === request.kind && b.objectName === request.objectName)
      )
        return {
          result: {
            data: {
              json: {
                ok: false,
                kind: "duplicate",
                binding: `${request.kind}/${request.objectName}`,
              },
            },
          },
        };
      const made = binding(`cb-${state.bindings.length + 3}`, request.kind, request.objectName);
      state = { ...state, bindings: [...state.bindings, made] };
      return {
        result: {
          data: {
            json: { ok: true, result: { binding: made, revision: 2 } },
            meta: {
              values: {
                "result.binding.createdAt": ["Date"],
                "result.binding.updatedAt": ["Date"],
              },
            },
          },
        },
      };
    },
    "environment.removeClusterBinding": (input) => {
      state = { ...state, bindings: state.bindings.filter((b) => b.id !== input?.bindingId) };
      return { result: { data: { json: { binding: null, revision: 3 } } } };
    },
    "environment.setClusterServiceAccount": (input) => {
      state = { ...state, serviceAccount: input?.request?.serviceAccount ?? null };
      return {
        result: {
          data: {
            json: { ok: true, result: { serviceAccount: state.serviceAccount, revision: 4 } },
          },
        },
      };
    },
  };
  let manage = true;
  await page.route("**/trpc/**", async (route) => {
    const paths = pathsOf(route.request());
    if (!manage && paths.includes("projects.detail")) {
      // Someone who can't change the project: the real read with `capabilities.manage` false.
      const response = await route.fetch();
      const json = await response.json();
      const list = Array.isArray(json) ? json : [json];
      for (const [index, path] of paths.entries()) {
        const detail = list[index]?.result?.data?.json;
        if (path === "projects.detail" && detail?.capabilities !== undefined)
          detail.capabilities.manage = false;
      }
      await route.fulfill({
        status: response.status(),
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(json) ? list : list[0]),
      });
      return;
    }
    if (!paths.some((path) => path in answers)) return route.continue();
    const body = route.request().postDataJSON() ?? {};
    const inputs = paths.map((_, index) => (body[index] ?? body)?.json);
    const others = paths.filter((path) => !(path in answers));
    let fetched = [];
    if (others.length > 0) {
      const response = await route.fetch();
      const json = await response.json();
      fetched = Array.isArray(json) ? json : [json];
    }
    const out = paths.map((path, index) =>
      path in answers ? answers[path](inputs[index]) : fetched[index],
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(route.request().url().includes("batch=1") ? out : out[0]),
    });
  });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate(home);
  await heading("Variables and secrets");
  await section().waitFor();
  await section().getByText("app-env", { exact: true }).waitFor();
  note(
    "on a Kubernetes server (rewritten read): Secret app-env and ConfigMap feature-flags, Bind an object, the service account",
  );
  await shot("project-cluster-bindings-desktop-light");

  await section().getByLabel("Bind an object").fill("payments-db");
  await button("Bind").click();
  await toastSays("Bound Secret payments-db.");
  await section().getByText("payments-db", { exact: true }).waitFor();
  note("cluster-bind-web: bound Secret payments-db; the toast says so and the list has it");
  await section().getByLabel("Bind an object").fill("app-env");
  await button("Bind").click();
  await section().getByText("Secret app-env is already bound to this project.").waitFor();
  note("cluster-bind-web: binding app-env again is refused beside the field (duplicate)");
  await shot("project-cluster-bindings-duplicate-desktop-light");

  await section().getByLabel("Workspace service account").fill("agent-readonly");
  await section().getByRole("button", { name: "Save", exact: true }).click();
  await toastSays("Workspaces run as agent-readonly.");
  await section().getByRole("button", { name: "Clear", exact: true }).waitFor();
  note("cluster-service-account: set agent-readonly; Clear appears");

  await button("Remove ConfigMap feature-flags").click();
  const remove = visible(page.getByRole("dialog", { name: "Remove ConfigMap feature-flags?" }));
  await shot("project-cluster-bindings-remove-desktop-light");
  await remove.getByRole("button", { name: "Remove binding", exact: true }).click();
  await toastSays("Removed ConfigMap feature-flags.");
  note("cluster-remove: removed ConfigMap feature-flags after asking");
  await paint("dark");
  await shot("project-cluster-bindings-desktop-dark");
  await paint("light");

  await section().getByRole("button", { name: "Clear", exact: true }).click();
  await toastSays("Workspaces run as the default service account again.");
  note("cluster-service-account: Clear puts workspaces back on the default account");

  manage = false;
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate(home);
  await section().getByText("app-env", { exact: true }).waitFor();
  for (const control of ["Bind", "Save", "Remove Secret app-env"])
    expect(
      `no ${control} for someone who can't change the project`,
      (await page.getByRole("button", { name: control, exact: true }).count()) === 0,
      control,
    );
  note(
    "read-only (project read rewritten, manage false): the bindings and the account, no Bind, Save or Remove",
  );
  await shot("project-cluster-bindings-read-only-desktop-light");
  manage = true;

  await page.setViewportSize(PHONE);
  await clearCache();
  await navigate("/settings/profile");
  await navigate(home);
  await section().waitFor();
  await shot("project-cluster-bindings-phone-light");
  await page.setViewportSize(DESKTOP);

  // --- Rewritten: no Kubernetes, but a binding left --------------------------------------------
  state = { ...state, clusterCapable: false, bindings: [binding("cb-1", "secret", "app-env")] };
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate(home);
  await section().getByText("These bindings can't resolve here.").waitFor();
  expect(
    "no Bind on a server without Kubernetes",
    (await page.getByRole("button", { name: "Bind", exact: true }).count()) === 0,
    "",
  );
  note(
    "cluster-local-runner: a binding left on a server without Kubernetes says it blocks sessions, and keeps Remove",
  );
  await shot("project-cluster-bindings-stranded-desktop-light");
  await button("Remove Secret app-env").click();
  await visible(page.getByRole("dialog", { name: "Remove Secret app-env?" }))
    .getByRole("button", { name: "Remove binding", exact: true })
    .click();
  await toastSays("Removed Secret app-env.");
  await page.waitForTimeout(1_000);
  const left = await page.getByRole("region", { name: "Cluster bindings" }).count();
  expect("the section goes once nothing is bound", left === 0, left);
  note("cluster-remove: once the last stranded binding is removed, the section goes");
  await page.unroute("**/trpc/**");
};
