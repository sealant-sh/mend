# Setup sessions and recorded proof artifacts

Status: agreed design for 0.37, not yet built. Yiannis supplied the setup and capture stories on
2026-11-01. The defaults he did not object to are recorded as design decisions below. The remaining
product questions are under [Open questions for Yiannis](#open-questions-for-yiannis), with a
recommendation for each. This ADR changes no runtime behavior.

## What people get

### Adopt a repository, then choose whether to set it up

A person adopts a repository. Mend asks whether to run a setup session, explains that it uses their
own agent login, and offers **Set up this project** and **Not now**. Adoption is complete either
way. No answer means no setup session. The project's **Set up this project** action remains
available later.

The person chooses their agent and says yes. Mend opens an ordinary session in a new worktree, with
Mend's setup prompt visible in its conversation. The person can watch, answer questions, stop it or
send a follow-up as in any other session. The person who starts it pays through their own agent
login. There is no separate onboarding agent or background inference pass.

The agent studies what the repository actually contains: app entry points, routes, commands,
existing instructions, tests, development setup and infrastructure. It proposes these files:

- `.mend/features.md`, a feature map saying what people can do, where each feature lives and which
  verification instructions cover it.
- `.mend/verify.md`, instructions for proving those features through the app as a person would.
- `.mend/mend.toml`, setup commands, Service recipes, a preview and `[resource.*]` definitions for
  the resources the app needs, where applicable.

For example, a task app's feature map points to the board route and its task code. Its verification
file says how to sign in, add a task, reload the board and observe the saved task. Its recipe starts
the web Service with `DATABASE_URL` mapped from `MEND_DB_URL`, and declares Postgres as `@db`. An
app with no database gets no invented database definition. An API-only repository still gets a
feature map and verification instructions, with browser capture marked unavailable.

The setup prompt also asks the agent to assess authentication. It records how a person signs in,
which flows require a login, whether a test account is needed, how to prepare test data, and which
project secrets or Doppler variables supply that account. It writes variable names and missing
requirements, never credentials. It also assesses which resources are needed, which can be shared,
and which need worktree data before migrations or verification writes.

The output is a change. The person opens Review, corrects assumptions or sends comments back, and
lands it through the normal landing flow if they want it on origin. The files travel with the code.
A later setup session reads existing files and proposes edits rather than overwriting them from a
blank template.

Writing, reviewing or landing these files starts nothing. This session studies the repository and
writes instructions; its prompt does not run setup commands, start Services or resources, migrate or
seed a database, or sign in to the app. It labels untried instructions as untried. The person can
ask a follow-up session to run them explicitly. A completed setup session means the agent finished
its turn, not that Mend has observed the app running.

### Review a UI change with before and after pictures

A later session changes how the task board displays a completed task. The agent reads the feature
map and verification file, chooses the relevant flow and captures the user's web app on the
session's screen. It attaches before and after screenshots and a short video of the after flow to
the change. The person can watch that screen while the agent drives it.

On the review page, beside the diff, the person sees a section named **Proof artifacts**. One item
might read `Completed task on board · before · base <commit> · observed <time>`. Its paired item
reads `Completed task on board · after · checkpoint <checkpoint> · observed <time>`. The video reads
`Complete a task and reload the board · after · observed <time>`. Opening an item shows the capture,
its source, session and screen-log link, and the agent's description of what it shows. These are
observations. The label never says the change "works".

The same labelled captures are available from the Slack thread, the phone's review and the PR body
when the owner lands the change. Review does not require landing. A person who needs more can tell
the same session, "Show the empty board too" or "Take another screenshot after signing in as the
test account." The agent adds another capture and keeps the earlier observations.

### Capture behind a login

The verification file says the board needs a project test account. The project supplies it through
project secrets or Doppler. The agent signs in through the app's normal flow, then captures the
board. It does not copy the owner's personal browser cookies into the screen.

ADR 0020 D10 gives every screen a fresh browser profile, discarded when the screen ends. A screen
restart therefore needs sign-in again. The setup assessment describes any external identity
provider, email link or one-time code the agent cannot complete with the supplied account. Missing
credentials produce `not captured · test account needed`, with the missing requirement. Mend does
not pretend that an anonymous page shows an authenticated flow. Credentials stay out of the
versioned files, labels and captures. Pixels can still contain account data; the project supplies a
test account and data suitable for everyone who can see the change.

This extends ADR 0020's instruction to stop at passwords for the specific case of a project-provided
test-account login. It does not supply a way past an external one-time code. ADR 0020 D6 also
records that native transcripts can retain typed tool arguments. This design does not promise to
redact those arguments. The capture implementation must account for that existing path when handling
project secrets and explain what the session record retains. Artifact media starts after sign-in and
its metadata keeps credential references, not values.

## Where this comes from

Yiannis described the wanted artifacts as:

> screenshot and video of the users product running on the sessions gui. I want before and after
> pictures.

He confirmed before and after screenshots, an after video, review, Slack, phone and PR presentation,
captures on request, and a project-provided test account through project secrets or Doppler.

[PR #562](https://github.com/sealant-sh/mend/pull/562) is the setup-session precedent. On his first
Cursor cloud session on Mend, the agent studied the repository and proposed operating notes. Its
diff records the product loop, prerequisites and environment traps. The useful result was a
reviewable repository edit explaining how to run the app. Mend's setup session makes that a
consented action with Mend's own prompt and writes the result under `.mend/`.

Mend's pstack verification work supplies the other precedent. The
[verify skill](../../.claude/skills/verify/SKILL.md) and its
[feature map](../../.claude/skills/verify/features/README.md) describe user entry points,
preconditions, exact actions, observable results, evidence and gotchas. A user's repository needs
that kind of specificity, not a copy of Mend's stack, CLI login instructions or verification
infrastructure. The setup session adapts the method to that app and links to its existing tests and
instructions where useful.

## Language

The product contract gains two terms:

- A `setup session` is an ordinary, consented session running Mend's prompt to propose a feature
  map, verification instructions and recipes under `.mend/`. It uses its starter's agent login and
  produces a change.
- A `proof artifact` is a selected screenshot or short video of the user's web app on a session's
  screen, attached to a change with its source and observation time. "Proof" names the material a
  person can inspect, never a verdict that the change works.

`Before` and `after` describe an artifact's source. They are not new product objects. A feature map
and a verification file are repository documents, not new session kinds or a context pack.

A `frame` remains one observation in ADR 0020's screen log. An artifact is a selected, labelled
review attachment, which can use a frame or a span and has the change's retention. A frame does not
become an artifact merely because the agent looked at the screen. The screen log is not a video
library, and "desktop" still means the Electron app.

## How the features fit existing Mend

### `.mend/`, Services and resources

[ADR 0019](0019-shared-services.md), including its November 1 amendment, owns resource definitions,
explicit starts, levels and env. `.mend/mend.toml` is the single file for definitions and recipes. A
root `mend.toml` is the existing fallback; `.mend/mend.toml` wins when both exist. If setup proposes
moving a root file, it carries forward the existing entries so that precedence cannot hide recipes.
It does not keep separate competing definitions in settings.

The `[setup]` recipe installs what the app needs when someone later starts a Service. It is distinct
from the setup session that writes the recipe. A Service is still a session's declared port, a
preview names its web Service, and `depends = ["@db"]` names a resource. A dependency never performs
a resource's first start. Recipe env explicitly maps `MEND_<NAME>_*` values to whatever names the
app expects. Resources remain optional when an app uses external infrastructure instead.

The verification file says what a person or agent must explicitly start, which level to choose and
what data the flow changes. Setup grants no permission to execute those instructions by itself.

### Before runs beside the change

The agent runs the app's recipe at the change's base commit in a side copy on another port. It never
checks out the base over the working files, resets the worktree, or changes its branch. The base
copy is temporary and separate from the worktree holding the change. It opens in a separate tab on
the session's screen, so Mend still records who drove the app and what the screen showed.

Use the recipe and lockfiles from the base. When the base has no Mend recipe, the agent can supply
an explicit launch command derived from the setup instructions and record that substitution. If it
cannot run the base, the before item says `not captured` and why. An after screenshot must never be
relabeled before to fill the gap.

The side copy needs separate writable data too. For an app with Postgres, run it in a temporary
worktree with its own database under ADR 0019, not the change worktree's database. Other resources
use worktree instances when the flow writes to them. These are explicit starts by the capturing
agent, with the same authority as its person. Neither the side copy nor a resource dependency starts
infrastructure implicitly. The agent stops only the processes it started and removes the temporary
worktree under the normal data-retention rules when capture finishes.

When that temporary worktree runs in another workspace, open its Service through Mend's existing
preview access from the session's browser. Do not assume one workspace can reach another's loopback.
Record the port override needed to run the base beside the after app.

Match the route, viewport, test-account role and starting fixtures where possible. The artifact
metadata describes the data used and any difference between the two runs. A base commit can be run
later than the after capture; "before" describes source, not capture order. Current external data,
changed services or different fixtures can affect the picture, so a pair is never a controlled
experiment merely because the images sit side by side.

For after, pin a checkpoint and run the app against that source. If other sessions keep writing, use
a side copy of the pinned checkpoint as well. Record the source and any build or recipe override. A
screen entry's `ObservedAfter` checkpoint link alone does not establish which tree the app ran. If
source cannot be established, label it `source unknown` rather than attaching it to a checkpoint as
exact proof. Later work does not silently update an earlier capture.

### ADR 0020's artifact seam

[ADR 0020](0020-guis-in-sessions.md#the-seam-for-recorded-proof-artifacts) already addresses a frame
with `ScreenMoment {screenId, seq}` and a log range with `ScreenSpan {screenId, fromSeq, toSeq}`. A
screenshot artifact references a moment. A video artifact references a span. Both carry the change,
contributing session, before or after source, observed start and end time, caption and media blob
reference. Metadata records the launch recipe or override, source commit or checkpoint, and known
fixture differences. Tool-call attribution remains exact, pending or a gap as ADR 0020 defines it. A
media attachment does not repair a missing tool call.

A video is an intentional capture of the after flow, under about 60 seconds. It needs a playable
media blob; stitching the sparse screen-log frames does not promise a faithful video. The screen's
live viewer stream is not itself a retained artifact. Capture and finalization use the session's
screen and preserve its input arbitration, including takeover. Interrupted or incomplete capture
says so and does not advertise a complete video. If media is missing, the attachment says `missing`
rather than substituting an unrelated frame. Capture failure leaves the session and diff usable.

This ADR extends ADR 0020's deferred video and holds seam. Its "no video" scope and decision-log
entry 17's "no holds table" describe the screen feature alone. Selected proof artifacts add bounded
video capture and retention holds; they do not turn every screen action into a recording.

### Storage, retention and access

Mend stores artifact media in its own blob store, with metadata attached to the change. Files left
in the workspace or harness home are not the durable copy. A workspace stop or session removal does
not delete the change's artifacts. Artifact media and the source frames they require are held for as
long as the change exists. Deleting the change releases those holds through normal blob cleanup.

ADR 0020 still expires ordinary screen-log frames after 30 days. The retention sweep checks holds
before deleting a blob needed by an artifact. A screenshot holds its selected frame. A video keeps
its finalized media and any source frames it depends on; it does not retain every unrelated frame in
that screen's log. A deleted change releases only its own holds. An already expired or missing frame
cannot be recovered by selecting it later. The label and provenance remain readable when unheld
neighboring frames have expired.

Anyone who can see the change can see its artifacts. Reads check current change visibility,
including after access is revoked; knowing a blob key grants no access. Artifact access follows the
change even if the source session has different visibility. The operator gets no default read access
to organization content. A link in Slack or GitHub never grants a new reader permission.

Review shows paired images and a video player beside the diff, with labels visible before opening
media. The phone offers the same captures in its review. Slack shows the captions and authenticated
links to open the captures. Landing adds labelled image and video links, sources and observation
times to Mend's existing section of the PR body. It names the landed checkpoint and distinguishes
artifacts from an older checkpoint. It preserves the person's text outside that section. A PR update
never makes old captures appear to describe new code.

Until Yiannis decides the publication question below, external destinations receive authenticated
links to Mend, not public blob URLs or uploaded copies. A private-network instance still needs to be
reachable by the reader. The PR body explains when opening media requires Mend access. Slack channel
membership and GitHub repository access alone do not grant change access.

## Decisions and alternatives

| Decision                     | Design                                                                                                                                                        | Alternative considered and why it was not chosen                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D1. Consent and cost         | Ask on adoption, require yes, retain **Set up this project** later. The starter's own agent login pays.                                                       | Automatic setup on adoption spends a person's login before they choose it.                                                                  |
| D2. Session and prompt       | An ordinary session runs Mend's visible prompt and proposes a change.                                                                                         | A hidden inference pass loses the conversation, normal steering and Review.                                                                 |
| D3. Repository output        | Write `.mend/features.md`, `.mend/verify.md` and recipes in `.mend/mend.toml`; assess auth and resources.                                                     | Provider-specific instructions alone do not give Mend a shared place to find the app's user flows.                                          |
| D4. Execution                | Setup writes instructions. Review and landing start nothing. Later execution follows explicit starts in ADR 0019.                                             | Running everything while onboarding mixes proposed instructions with data and infrastructure writes outside the diff.                       |
| D5. Capture choice           | The session's agent chooses relevant captures from the feature map and verification instructions. A person can ask for more.                                  | A fixed screenshot of every route adds unrelated images. Requiring a request for every image makes the person specify the whole proof flow. |
| D6. Before source            | Run the base recipe in an isolated side copy on another port, with separate writable data.                                                                    | Checking out the base in the change worktree disturbs the work in progress. An old screenshot has no established base source.               |
| D7. Video                    | Capture only the after flow, under about 60 seconds.                                                                                                          | Before videos and continuous session video increase storage and review time without answering the requested before and after picture story. |
| D8. Lifetime                 | Keep artifacts as long as the change, using blob retention holds; unselected screen frames still expire after 30 days.                                        | Expiring review media with all screen frames makes an older change lose its selected evidence.                                              |
| D9. First scope              | Web apps only for proof artifacts in v1. Setup can describe other repositories and mark browser capture unavailable.                                          | Supporting native and Electron capture now adds flows beyond the requested web recipe design. ADR 0020's screen can still run other X apps. |
| D10. Evidence                | Label what the artifact shows, its source and when it was observed, with gaps stated.                                                                         | A "works" badge turns a picture into a verdict it cannot support.                                                                           |
| D11. Login                   | Use the project's test account through project secrets or Doppler, and sign in afresh after a screen ends.                                                    | Persisting personal cookies reverses ADR 0020 D10 and adds another secret store.                                                            |
| D12. Presentation and access | Review, Slack, phone and landed PR bodies expose the same labelled artifacts to people who can see the change. External links require Mend access pending Q1. | Unauthenticated blobs or automatic uploads give a different audience access without a publication decision.                                 |

## Open questions for Yiannis

These are product choices left after the confirmed stories and defaults. They do not reopen consent,
the base side copy, the short after video, web-only scope or retention for the life of the change.

### Q1. Should landing or Slack copy media to an audience outside Mend?

A public PR, or a Slack channel with guests, can have readers who cannot see the change. A Mend link
preserves change visibility but those readers cannot open it. Uploaded media would remain with the
external service under its access and deletion rules.

Recommendation: ship authenticated links in v1. If broader publication is wanted, make publishing
copies an explicit act by the change owner that names the destination and audience. Do not make
landing itself consent to a larger media audience.

### Q2. May the change owner withdraw a sensitive capture while keeping the change?

Keeping an artifact for the change's lifetime is the default. A test app can still show something
the person did not intend to keep. The current design has no separate withdrawal action, and
deleting a change is a large response to one image.

Recommendation: allow the change owner to withdraw selected media explicitly, keeping a
`withdrawn by <person>` placeholder and its source metadata. Explain that Mend cannot withdraw
copies someone already downloaded or published elsewhere. This would be an explicit exception to the
retention default, not a shorter automatic retention period.

## Implementation boundary and checks for the later build

This PR is documentation only. Mend continues to use the public `@sealant/sdk`; missing support for
side copies, media capture or blob transfer belongs in platform feedback before implementation, not
an import of Sealant internals. This design does not introduce a second agent or depend on a new
platform recording product.

The later feature check must exercise the stories as a person on the box: decline setup, start it
later with the starter's login, review the proposed files, and observe that no resources or Services
started. Then use an authenticated web app, capture base and after without disturbing its change,
ask for another capture, and inspect the same items on Review, Slack, phone and a landed PR. Check
an unavailable base and a missing test account, a screen restart requiring sign-in, retention beyond
ordinary frame expiry, a later checkpoint, and a reader who loses change access. The observations
belong on the implementation PRs under AGENTS.md, not on this unbuilt design.
