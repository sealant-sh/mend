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
If a root mend.toml exists, carry its entries forward: .mend/mend.toml takes precedence and must not hide existing recipes.
[setup] holds commands for a later Service start; it is distinct from this setup session. A Service is a declared port; [preview] names its web Service.
Declare real resources such as @db only when needed. A dependency such as depends = ["@db"] does not start it.
Map resource env explicitly from MEND_<NAME>_* to the names the app reads, for example DATABASE_URL = "\${MEND_DB_URL}".
Assess which resources can be shared and which need worktree data before migrations or verification writes. Document explicit starts and their project or worktree level.
Keep external infrastructure when that is what the app uses. Do not invent a database or browser app.
For an API-only repository, write verification for its actual entry points and mark browser capture unavailable.

Assess authentication and document which flows need a login, the test-user role, test data, runtime secret names and missing prerequisites.
For OAuth or another external provider, study the app's own session storage and cookie validation.
Write .mend/create-test-session.<ext> using the app's language and libraries. It must create a signed-in test session directly in the dev database or sign the session cookie with the dev secret, reading secrets at runtime.
Document the exact script command, database and test-user prerequisites, runtime secret names, and how a later agent puts the resulting session into the screen's browser. Captures skip the external provider's sign-in flow.
Target development test data only. Do not copy a personal browser session or change production authentication.
For password auth, document the existing seed script or the exact sign-up flow, and the project-secret or Doppler names that supply the test account.
Give the app's exact commands to supply them: mend env load /path/outside/repo/capture.env --secret --project <p>, or doppler secrets upload /path/outside/repo/capture.env --project <p> --config <c>.
Use the actual project and config names when established; state what remains unknown. The file with secret values stays outside the repository.
Never write secret values, signed cookies or tokens into .mend/, source, instructions or reports. Scripts read secrets at runtime.
Every screen has a fresh browser profile. Document how to repeat test-session creation or password sign-in after a screen ends.

Study and write only. Do not run setup commands, install dependencies, start Services or resources, migrate or seed data, sign in, or capture proof.
Do not push, open a pull request or run mend land. Writing these files grants no permission to execute them.
Mark every untried procedure "not tried during setup". A completed turn describes your work, not an observation of the app running.
Finish with a short summary of what you wrote and what you could not establish.`;
