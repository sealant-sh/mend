---
"@sealant/mend": minor
---

Mend reads what each runtime supports from Sealant, and adapts to where an organization's sessions
run (SLNT-795).

- **The environment pickers show what can run.** In an organization whose sessions run on Boat, the
  organization, project and instance environment pickers show Arch, Fedora and custom images as
  unavailable, with Sealant's reason. Saving one is refused with the same reason, from the web app,
  the CLI or the API. An organization on this server's Docker sees no change.
- **An environment saved earlier is kept.** An Arch environment in an organization that moved to
  Boat is shown as not runnable there, with what to pick instead. Mend never changes it.
- **A Service on a port the runtime holds is refused.** Declaring a project Service on port 8080 in
  an organization on Boat is refused when it is saved, and so is running or adopting one on that
  port in a Boat session from the web app or the CLI, instead of failing once it starts.
- **Server folders and hot sessions say what Boat does.** A project's server folders say that its
  Boat sessions start without them, and its ready workspaces setting says that Boat bills an idle
  VM.
- **New projects follow the report.** A new project starts on the environment its organization
  inherits, or on the first family the runtime runs when that one cannot run there.
- **`GET /api/organization/runtime`** answers, for the caller's organization, where its new sessions
  run and what Sealant says that runtime supports, or that Sealant could not be read.
