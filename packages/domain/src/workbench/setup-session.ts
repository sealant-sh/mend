/** The visible opening message for a consented setup session. It authorizes repository edits only. */
export const SETUP_SESSION_PROMPT = `Set up this project for later Mend sessions by studying the repository and proposing a change under .mend/.
This is a setup session. Your starter's own agent login pays for it. The result is a change for them to review and land if they choose.

Read the actual repository before writing: entry points, routes, commands, README, AGENTS.md, CLAUDE.md, tests, dev setup and infrastructure.
Read existing .mend/ files first. Edit useful instructions in place; do not replace them with a blank template.
Follow the app's own conventions. Write dense facts with their reasons, exact paths and exact commands. Separate observations from assumptions.

Write or update these files:
- .mend/features.md: what people can do, where each feature lives, and the matching entry in verify.md.
- .mend/verify.md: how to prove each feature through the app as a person would. Give preconditions, exact actions, what to observe, relevant tests and environment traps with their reasons.
- .mend/mend.toml: [setup], Service recipes under [service.<name>], [preview], and [resource.<name>] only where the app actually needs them.

Authentication is a main setup deliverable. Every .mend/verify.md must include this Markdown structure, filled with repository facts and source paths, not placeholder claims:
## Authentication
### Providers and configuration
| Provider or method | Configuration source | Required env names | Callback or redirect paths |
| --- | --- | --- | --- |
Identify every OAuth/OIDC provider, magic links, password and SSO flow the app supports. Include auth-library configuration, routes, base-URL settings, required secret names and which user flows need a login. Names only, never values. If none is found, write "no authentication found" with the inspected paths; distinguish that from unknown configuration.
### Addresses and provider registration
| Access | App origin | Callback URLs | Register at | Allowed origins and cookie settings | Status |
| --- | --- | --- | --- | --- | --- |
Write separate registration rows for the Mend preview, localhost on the person's machine and localhost inside the workspace for each provider. Use a configured fixed project preview address when Mend exposes one; otherwise use the current worktree's preview, with the unknown-address steps below when needed. Never assume the fixed-address feature is available or invent its configuration. Use the app's actual callback paths and full URLs, including scheme and port, not /preview-auth or /__mend/auth. Record callback methods, authorized origins, logout/redirect allowlists, cookie domain, Secure and SameSite requirements where applicable. Name the provider console, application and settings fields to edit, with source links when established. Mend cannot register callbacks with the provider; tell the person exactly what to add and where. If a provider allows only one callback URL, document separate development provider applications where supported.
For localhost on the person's machine, choose an explicit local port and record http://localhost:<local-port> plus each actual callback path as exact provider registration URLs. Tell the person to register them, then run mend service connect <service> --port <local-port> with that same local port and open http://localhost:<local-port> on their machine. Keep the tunnel running during sign-in. Document the app's public/base-URL setting for that localhost origin, separately from its preview setting; change it and restart the Service when required. A browser on the person's machine receives the provider callback there and the tunnel carries it to the workspace. This is separate from the workspace's localhost and its Service port; choose the app's required hostname or scheme when localhost HTTP is unsupported.
Use a fixed port in [service.<name>] matching the app's callback assumptions. Make the command honor PORT or pass that same port explicitly, and fail if the port is occupied rather than silently pick another. Localhost callbacks use http://localhost:<fixed-port> plus each actual callback path, unless the app requires another scheme or loopback hostname. Record those requirements; a random CLI tunnel port is a different address.
Mend supplies MEND_PREVIEW_URL to a Service when its preview has an address. Document how the Service command maps it to the app's actual public/base-URL setting, or how to set that setting explicitly. It is not automatically available in the agent's shell, and Mend does not automatically configure auth libraries. Assess host = "rewrite" versus "preserve" and the app's trust of X-Forwarded-Host/X-Forwarded-Proto. Never put PORT or MEND_* assignments in recipe env.
Until fixed project previews are available, preview addresses belong to a worktree and Service, not a project: each new worktree needs its own provider registration. On the ts.net default the external preview port is assigned separately from the fixed workspace port and can be reassigned after inactivity or operator changes. Current recipes cannot pin a project-wide preview address or external preview port; a future fixed address must be established from Mend, never guessed.
If no preview address is established, record "unknown" and the missing input. Never invent a preview URL or assume the setup worktree's address applies to future worktrees. Write these later steps in verify.md: after explicit authorization to run, start the declared resources at the documented level and the Service with mend service <name>; open its preview using Open in a new tab, complete Mend sign-in, and copy only the final app origin from the address bar, without tickets or query strings. MEND_PREVIEW_URL in the Service process can also establish that origin when set. Then append each callback path, fill in the preview row, register those exact URLs and origins with the provider, set the app's base URL and restart the Service if its configuration changed. Recheck the address on a new worktree or reassignment.
The gateway refuses cross-origin POST callbacks, including OIDC form_post and SAML POST responses. Record an app/provider limit when that flow is required. Document a supported GET callback alternative only if the app/provider offers it; registering a URL alone does not fix this constraint. Also record provider HTTPS, domain-verification or private-network requirements that cannot be established during setup.
### Sign-in for checks
Document which flows need a login, the test-user role, test data, runtime secret names and missing prerequisites.
For OAuth or another external provider, study the app's own session storage and cookie validation.
Write .mend/create-test-session.<ext> using the app's language and libraries. It must create a signed-in test session directly in the dev database or sign the session cookie with the dev secret, reading secrets at runtime.
Document the exact script command, database and test-user prerequisites, runtime secret names, expiry, cleanup, and how a later agent puts the resulting session into the screen's browser. Specify the target origin, cookie name, domain, path, Secure, HttpOnly and SameSite attributes and account for preview cookie handling, including the ts.net gateway's HttpOnly cookie namespace. Prefer an app-supported session response or browser-state import that keeps auth material outside the repository, without printing them or putting values in tool arguments. Captures skip the external provider's sign-in flow; this does not verify OAuth itself.
Target development test data only. Do not copy a personal browser session or change production authentication. If supported session creation cannot be established, do not fabricate a session format or weaken auth; name the blocker and any supported test-mode alternative.
For password auth, document the existing seed script or the exact sign-up flow, and the project-secret or Doppler names that supply the test account. For magic links or SSO, record the supported development/test route and any missing prerequisite instead of assuming a password account exists.
Give the app's exact commands to supply them: mend env load /path/outside/repo/capture.env --secret --project <p>, or doppler secrets upload /path/outside/repo/capture.env --project <p> --config <c>.
Use the actual project and config names when established; state what remains unknown. The file with secret values stays outside the repository.
Never write secret values, signed cookies or tokens into .mend/, source, instructions or reports. Scripts read secrets at runtime; transient browser state stays outside the repository and is removed after use.
Every screen has a fresh browser profile. Document how to repeat test-session creation or password sign-in after a screen ends.
### Missing prerequisites
List unresolved provider registration, preview origins, secrets by name, test data and unsupported auth flows, with the exact person action or later check needed. Distinguish instructions derived from code from observed behavior. Never claim registration or sign-in was tried during setup.

Recipes and resources:
If a root mend.toml exists, carry its entries forward: .mend/mend.toml takes precedence and must not hide existing recipes.
[setup] holds commands for a later Service start; it is distinct from this setup session. A Service is a declared port; [preview] names its web Service.
Declare real resources such as @db only when needed. A dependency such as depends = ["@db"] does not start it.
Map resource env explicitly from MEND_<NAME>_* to the names the app reads, for example DATABASE_URL = "\${MEND_DB_URL}".
Assess which resources can be shared and which need worktree data before migrations or verification writes. Document explicit starts and their project or worktree level.
Keep external infrastructure when that is what the app uses. Do not invent a database or browser app.
For an API-only repository, write verification for its actual entry points and mark browser capture unavailable.

Study and write only. Do not run setup commands, install dependencies, start Services or resources, migrate or seed data, sign in, or capture proof.
Do not push, open a pull request or run mend land. Writing these files grants no permission to execute them.
Mark every untried procedure "not tried during setup". A completed turn describes your work, not an observation of the app running.
Finish with a short summary of what you wrote and what you could not establish.`;
