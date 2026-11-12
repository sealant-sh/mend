# Cluster bindings

On a Mend server whose workspaces run on Kubernetes, a project can bind cluster objects by name: a
Kubernetes Secret or ConfigMap in the platform's workspaces namespace whose keys become workspace
environment, and optionally the service account the workspaces run as. Mend stores the names only
and never sees the contents; the platform resolves them at each fresh workspace launch. A user binds
and removes them on the project's Setup tab or with `mend env cluster`, and `mend env show` lists
them beside configuration and secret names. On a local-runner install bindings do not resolve, and a
declared binding blocks launches until it is removed.

## Sub-features

- `cluster-bind-web` binds a `secret` or `configmap` by object name from the `Cluster bindings`
  panel.
- `cluster-bind-cli` binds with `mend env cluster add secret|configmap <name>`.
- `cluster-remove` removes a binding (two clicks on the web, `mend env cluster remove <kind>/<name>`
  in the CLI).
- `cluster-service-account` sets or clears the workspace service account (`Set`/`Clear`,
  `mend env cluster sa <name>|--clear`).
- `cluster-show` lists bindings and the service account in `mend env show`.
- `cluster-local-runner` shows the degraded panel on a non-Kubernetes install and keeps `Remove`
  available.
- `cluster-delivery` hands the bound object's keys to the next launched workspace.

## How to get to it (user POV)

- Web: a project's Setup tab, section `Cluster bindings` (anchor `#cluster-bindings`), for the
  project's creator and organization owners.
- CLI: `mend env cluster add secret|configmap <name>`, `mend env cluster remove <kind>/<name>`,
  `mend env cluster sa <name> | sa --clear`, each with `[--project <p>]`; `mend env show` lists the
  result.
- TUI, desktop, mobile, VS Code, Slack: no surface.

## Driving it with verify

Preconditions:

- Mend runs on a Kubernetes deployment of Sealant (the web panel shows no local-runner warning). On
  any other install only the `cluster-local-runner` steps apply; report the rest unreachable with
  "server is not Kubernetes-backed".
- The operator has created a Secret `verify-env` in the platform's workspaces namespace, labelled
  for workspace environment, holding the key `VERIFY_CLUSTER=from-cluster`, and allowlisted a
  service account `<sa>` for workspaces. Launch names both.
- The browser is signed in as the creator of `<project>` (or an owner), and
  `mend env show --project <project>` lists no `cluster binding` lines.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`.

- **Open the panel.** Open `<project>`'s Setup tab. `section("Cluster bindings")` reads
  `No cluster bindings.` and shows the combobox `Kind` (options `secret`, `configmap`), the textbox
  `Object name` and the disabled button `Bind`.
- **Bind on the web.** Run
  `await section("Cluster bindings").getByRole("combobox", { name: "Kind" }).selectOption("secret")`,
  `await section("Cluster bindings").getByRole("textbox", { name: "Object name" }).fill("verify-env")`
  and `await section("Cluster bindings").getByRole("button", { name: "Bind" }).click()`. The panel
  status (`section("Cluster bindings").getByRole("status")`) reads `Bound secret/verify-env.`, the
  textbox empties, and a list item reads `secret/verify-env` with
  `resolved by the platform at launch · contents unknown to Mend`.
- **Duplicate refused.** Bind `secret`/`verify-env` again. A line reads
  `secret/verify-env is already bound on this project.` and the list still has one item.
- **Service account.** Run
  `await section("Cluster bindings").getByRole("textbox", { name: "Workspace service account" }).fill("<sa>")`
  and choose `Set`. The status reads `Set service account <sa>.` and a `Clear` button appears.
- **CLI show.** Run `mend env show --project <project>`. Exit code `0`. Lines read
  `  secret/verify-env  cluster binding · resolved by the platform at launch · contents unknown to Mend`
  and `  <sa>  service account · workspace pod identity · allowlisted by the operator` (names padded
  to one width).
- **Delivery.** Run
  `mend run --project <project> -- sh -c 'printf "%s\n" "$VERIFY_CLUSTER" > CLUSTER.txt'`. Exit code
  `0`. The session's change adds `CLUSTER.txt` with the line `from-cluster`.
- **CLI add.** Run `mend env cluster add configmap verify-config --project <project>`. Exit code
  `0`. Stdout reads `✓ bound configmap/verify-config · cluster r<n>`,
  `  resolved by the platform at launch · contents unknown to Mend` and
  `  applies from the next workspace launch; running workspaces keep what they started with`.
- **CLI remove.** Run `mend env cluster remove configmap/verify-config --project <project>`. Stdout
  reads `✓ removed configmap/verify-config · cluster r<n>` and the applies line. Run it again: exit
  code `1`, stderr `mend: configmap/verify-config is not bound on <project>`.
- **CLI service account.** Run `mend env cluster sa --clear --project <project>`. Stdout reads
  `✓ cleared the workspace service account · cluster r<n>` and the applies line. Run
  `mend env cluster sa <sa> --project <project>`: `✓ service account <sa> · cluster r<n>`, then the
  warning that the session agent holds the role's full permissions, then the applies line.
- **Remove on the web.** Choose `Remove` on the `secret/verify-env` item. It reads
  `Remove? Running workspaces keep it`; choose it again. The status reads
  `Removed secret/verify-env.` and the panel reads `No cluster bindings.`
- **Local-runner install (cluster-local-runner).** On a non-Kubernetes install, the panel reads
  `This install runs workspaces on the local runner. Cluster bindings do not resolve here; declared bindings block launches — remove them to launch here.`
  `Kind`, `Object name`, `Bind`, the service account textbox and `Set` are disabled; `Remove` and
  `Clear` stay enabled. With a binding added from the CLI, `mend env show` ends
  `  <n> cluster binding · service account set · local runner — cluster bindings do not resolve here`
  (` · service account set` only when one is set), and `mend run --project <project> -- true` prints
  `mend: launch refused · secret/verify-env · service account <sa> · cluster bindings do not resolve on this deployment's workspace runtime — remove them in project setup to launch here`.
- **Proof.** Save the panel's ARIA snapshot and a screenshot with `secret/verify-env` bound and
  after removal, the `mend env show` and `mend env cluster` transcripts with exit codes, and the
  review page showing `CLUSTER.txt`.

## Gotchas

- The CLI binds on any install, including a local runner where the web disables `Bind`. A binding
  added that way blocks every launch in the project there; the launch is refused and the refusal
  names every binding. Remove it (`mend env cluster remove …` or the web `Remove`) to launch again.
  Never leave a binding behind on a shared local instance.
- A duplicate bind from the CLI exits `1` with the bare status line
  `mend: POST /projects/<id>/cluster-bindings → 409`: the conflict carries no message for the CLI to
  print (`packages/api-contracts/src/project-environment.ts:177`). The web says which binding.
- Object names follow Kubernetes DNS-1123 subdomain grammar and a project holds at most 16 bindings
  (docs). A refused name comes back as the server's own message.
- Only objects the operator labelled for workspace environment resolve, and a service account
  outside the operator's allowlist fails the launch. Both are cluster-side; the panel cannot show
  them.
- `Remove` takes two clicks and arms per row; the armed text names nothing, so read the list item
  around it.
- The `Cluster bindings` section has no region role; scope by its heading. The service account
  textbox's placeholder `none` is not its name; its name is the `aria-label`
  `Workspace service account`.
