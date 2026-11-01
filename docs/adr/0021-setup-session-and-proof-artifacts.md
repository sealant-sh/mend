# Setup sessions and recorded proof artifacts

Status: agreed design for 0.37, not yet built. Yiannis supplied the setup and capture stories on
2026-11-01 and has decided delivery, authentication, withdrawal and build order. Those decisions
replace the earlier open questions in this ADR. This document changes no runtime behavior.

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
- A script under `.mend/` for creating a signed-in test session when the app uses OAuth or another
  external provider. Its code uses runtime secrets and never embeds their values.

For example, a task app's feature map points to the board route and its task code. Its verification
file says how to sign in, add a task, reload the board and observe the saved task. Its recipe starts
the web Service with `DATABASE_URL` mapped from `MEND_DB_URL`, and declares Postgres as `@db`. An
app with no database gets no invented database definition. An API-only repository still gets a
feature map and verification instructions, with browser capture marked unavailable.

The setup prompt also asks the agent to assess authentication. It records how a person signs in,
which flows require a login, whether a test account is needed, how to prepare test data, and which
project secrets or Doppler variables supply that account. For an external provider it writes a
script that creates the app's own signed-in test session; for password auth it documents the
account's seed or sign-up flow and the commands to supply credentials. It writes no secret values.
It also assesses which resources are needed, which can be shared, and which need worktree data
before migrations or verification writes.

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

Mend uploads the screenshots and video as files into the session's Slack thread. T3 Code shows them
inline in the session's thread. The phone's review shows the same captures, and the PR body embeds
the images and video when the owner lands the change. Review does not require landing. A person who
needs more can tell the same session, "Show the empty board too" or "Take another screenshot after
signing in as the test account." The agent adds another capture and keeps the earlier observations.

### Capture behind a login

The setup session works out how to get a signed-in test user and writes that procedure into
`.mend/verify.md`. It does not leave an external provider's sign-in screen as the capture plan.

For OAuth or another external provider, the agent studies the app's own session storage and cookie
validation. It writes a script under `.mend/` that creates a valid session for a test user directly
in the app's development database, or signs the session cookie with the app's own dev secret.
`verify.md` gives the command, runtime secret names, database and test-user prerequisites, and how
to put the resulting session into the screen's browser. Captures skip the provider's flow. The
script targets development test data; it does not copy a personal browser session or change the
app's production authentication.

For password auth, `verify.md` names the seed script that creates the account, or documents the
sign-up flow that does. It gives the exact project secret or Doppler names and the command to set
them. For example, a task-board repo whose seed reads `TEST_USER_EMAIL` and `TEST_USER_PASSWORD` can
document `mend env load /path/outside/repo/capture.env --secret --project task-board`, then its own
`pnpm seed:test-user` command. A Doppler-backed repo can document
`doppler secrets upload /path/outside/repo/capture.env --project task-board --config dev` instead.
The local file contains the values and stays outside the repository. These are examples; setup
writes the names and commands the actual app needs, including the selected Doppler project and
config. No secret value, signed cookie or session token is written into `.mend/`.

ADR 0020 D10 still gives every screen a fresh browser profile, discarded when the screen ends. On
restart the agent repeats the documented test-session script or password sign-in. It runs the auth
preparation against each capture's own data and source, so a base copy does not use the after app's
session database. If a prerequisite is missing, the artifact says `not captured` and names what is
missing. Setup supplies an executable plan rather than claiming it has already run it.

This extends ADR 0020's stop-at-password instruction for the project's test account. ADR 0020 D6
notes that native transcripts can retain typed tool arguments. Secret values belong in runtime
secret inputs rather than literal tool arguments or generated source. Artifact media starts after
auth preparation, metadata keeps secret names rather than values, and the implementation must
account for what the session record retains. The app's visible account data still appears in the
capture, so the project uses test data suitable for its delivery audiences.

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

Anyone who can see the change can see its artifacts in Mend. Reads check current change visibility,
including after access is revoked; knowing a blob key grants no access. Artifact access follows the
change even if the source session has different visibility. The operator gets no default read access
to organization content.

Review shows paired images and a video player beside the diff, with labels visible before opening
media. The phone offers the same captures in its review. These designs remain unchanged.

### Delivery to Slack and T3 Code

Slack receives files, not a list of links. Mend uploads each selected screenshot and the after video
into the session's Slack thread through its Slack app, with the source and observation caption. A
person can inspect them there without opening Mend. Delivery records the returned file and message
identities so a retry does not repost media already delivered. Failure names the files not
delivered; it does not replace them with an apparent success made of links.

[ADR 0012](0012-t3code-gateway.md) makes `apps/t3-gateway` an adapter, with Mend as the source of
truth. Its current `thread-projection.ts` already carries `ChatImageAttachment` metadata for message
images, and `assets.ts` serves device-bound image assets and ranged media-file previews through
`assets.createUrl`. Those are existing ways to render media, not a proof-artifact feed. The current
RPC path resolves attachments through `hub.imageOf`, which holds incoming chat images; its file
preview path reads worktree files. Neither is a durable read of proof media in Mend's blob store. A
completed tool row alone does not attach the artifact images.

Extend the projection to put labelled proof screenshots and the after video inline in the session's
thread, with stable artifact identities so reconnects update the same items. Add a proof-artifact
asset subject resolved by artifact ID and checked against current change access. It reads Mend's
blob store, not a workspace path or expiring screen-frame URL, and reuses device-bound grants, MIME
handling, byte ranges for video, budgets and revocation checks. Project screenshots through the
client's image rendering and the video through its inline media player, with the before or after
source and observation caption beside them. This is output, not an attachment submitted as a new
agent turn. If the pinned client needs a media projection extension, update the supported pin and
its projection checks; a link-only system notice is not delivery of this feature. Vendored contracts
are updated through ADR 0012's copy process, never edited by hand.

Once posted, a copy lives in Slack, T3 Code or GitHub under that service's access rules. Yiannis
accepts this publication consequence. Slack channel readers can see uploaded files under Slack's
rules; T3 Code can retain displayed or downloaded media under its own client and thread rules.
Revoking Mend access does not recall a copy already delivered. On a public repository anyone can see
the GitHub media. These external copies are separate from Mend's change-lifetime retention.

### Embedded media in the PR body

Landing uploads the selected media as GitHub-native attachments in the same repository as the PR.
Use the existing landing workspace and the change owner's GitHub login, with a `gh` version that
supports `gh pr create --attach` and `gh pr edit --attach`. Build Mend's section of the body with
local screenshot references and a standalone video reference, then pass the files with `--attach`.
The CLI replaces the image paths with uploaded URLs that render as images and the standalone video
reference with a GitHub video player. A plain text link is not the result. Keep the resulting URLs
and delivery identities so later body updates reuse uploads. Preserve the person's text outside
Mend's section and report partial upload failure accurately.

For example, a prepared body contains `![Board before](./before.png)` and
`![Board after](./after.png)`, each beside its source and observation caption. A separate paragraph
contains only `![](./after.mp4)`. A later landing uses
`gh pr edit <number> --body-file <body> --attach ./before.png --attach ./after.png --attach ./after.mp4`
for media not yet uploaded. The body names the landed checkpoint and distinguishes older captures; a
PR update never makes an old image appear to show new code.

The mechanism check found a supported private-repository path in GitHub's
[attachment documentation](https://github.com/github/docs/blob/main/content/get-started/writing-on-github/working-with-advanced-formatting/attaching-files.md):
private and internal repository uploads are viewable by people with repository access; public
repository uploads need no authentication. GitHub's
[CLI attachment guide](https://github.com/github/docs/blob/main/content/github-cli/github-cli/attaching-files-with-github-cli.md)
explicitly documents `--attach`, inline images, video players and the required repository push
access. The installed `gh pr edit --help` exposes that flag too. This is a documentation and CLI
capability check, not a claim of a live private-PR browser test. That rendering and access check
belongs in the implementation check below.

The proposed `refs/mend/artifacts/<change>` is not the serving mechanism. A Git ref preserves blobs
but does not itself provide an authenticated image or video embedding service. The Markdown API
probe preserved the supplied raw URL; it did not establish private-repository rendering or grant
reader access. We did not establish a durable private embed from an arbitrary ref. GitHub-native
attachments provide the documented alternative for both public and private repositories, without
adding binary commits, another branch lifecycle or a separate media host. No token or temporary
signed raw URL goes in a PR body. If the installed CLI or repository permissions cannot upload,
landing reports media delivery unavailable rather than silently publishing a link-only substitute.

## Decisions and alternatives

| Decision                            | Design                                                                                                                                                                                                                                                                  | Alternative considered and why it was not chosen                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D1. Consent and cost                | Ask on adoption, require yes, retain **Set up this project** later. The starter's own agent login pays.                                                                                                                                                                 | Automatic setup on adoption spends a person's login before they choose it.                                                                  |
| D2. Session and prompt              | An ordinary session runs Mend's visible prompt and proposes a change.                                                                                                                                                                                                   | A hidden inference pass loses the conversation, normal steering and Review.                                                                 |
| D3. Repository output               | Write `.mend/features.md`, `.mend/verify.md`, recipes and any external-auth test-session script under `.mend/`; assess resources.                                                                                                                                       | Provider-specific notes alone do not give later sessions runnable user flows.                                                               |
| D4. Execution                       | Setup writes instructions. Review and landing start nothing. Later execution follows explicit starts in ADR 0019.                                                                                                                                                       | Running everything while onboarding mixes proposed instructions with data and infrastructure writes outside the diff.                       |
| D5. Capture choice                  | The session's agent chooses relevant captures from the feature map and verification instructions. A person can ask for more.                                                                                                                                            | A fixed screenshot of every route adds unrelated images. Requiring a request for every image makes the person specify the whole proof flow. |
| D6. Before source                   | Run the base recipe in an isolated side copy on another port, with separate writable data.                                                                                                                                                                              | Checking out the base in the change worktree disturbs the work in progress. An old screenshot has no established base source.               |
| D7. Video                           | Capture only the after flow, under about 60 seconds.                                                                                                                                                                                                                    | Before videos and continuous session video increase storage and review time without answering the requested before and after picture story. |
| D8. Lifetime                        | Keep artifacts as long as the change, using blob retention holds; unselected screen frames still expire after 30 days.                                                                                                                                                  | Expiring review media with all screen frames makes an older change lose its selected evidence.                                              |
| D9. First scope                     | Web apps only for proof artifacts in v1. Setup can describe other repositories and mark browser capture unavailable.                                                                                                                                                    | Supporting native and Electron capture now adds flows beyond the requested web recipe design. ADR 0020's screen can still run other X apps. |
| D10. Evidence                       | Label what the artifact shows, its source and when it was observed, with gaps stated.                                                                                                                                                                                   | A "works" badge turns a picture into a verdict it cannot support.                                                                           |
| D11. Authentication, decided        | Setup writes an app-specific session-creation or cookie-signing script for external providers. For password auth it documents the seed or sign-up flow, exact secret names and commands to set them. No secret values in `.mend/`; repeat auth after a screen ends.     | Asking the person to complete OAuth for every capture leaves onboarding unfinished. Personal cookies would reverse ADR 0020 D10.            |
| D12. Delivery and audience, decided | Upload screenshots and video as files to the Slack thread and show them inline through the T3 Code gateway. Review and phone keep their designed presentation. Posted copies follow the destination service's rules; public-repo media is public. Yiannis accepts this. | Authenticated Mend links alone do not show real media where the person is working.                                                          |
| D13. PR media, decided design       | Use GitHub-native uploads through `gh --attach`, embedding screenshots and a video player in the PR body. GitHub documents repository-reader access for private uploads.                                                                                                | A custom Git ref alone has no verified private inline-serving path; link-only bodies do not meet the request.                               |
| D14. Withdrawal, decided            | Withdrawing a capture is deferred to later work.                                                                                                                                                                                                                        | An owner withdrawal action and placeholder add work outside this build.                                                                     |
| D15. Priority, decided              | Build capture, Slack and T3 Code delivery, setup including auth, PR embedding, then Review and phone, in that order.                                                                                                                                                    | Building Review first delays the two clients Yiannis prioritizes.                                                                           |

## Build order

1. Capture before and after screenshots and the after video, with the base side copy.
2. Deliver files to Slack and show the captures inline in T3 Code.
3. Build the setup session, including auth preparation and its `.mend/` instructions and scripts.
4. Embed media in the PR body.
5. Add the review page and phone presentation.

Capture and early delivery can use a project's existing recipes and explicit auth instructions until
the setup session writes them. This order does not make setup an automatic prerequisite for a
capture.

## Implementation boundary and checks for the later build

This PR is documentation only. Mend continues to use the public `@sealant/sdk`; missing support for
side copies, media capture or blob transfer belongs in platform feedback before implementation, not
an import of Sealant internals. This design does not introduce a second agent or depend on a new
platform recording product.

The later feature check must exercise the stories as a person on the box: decline setup, start it
later with the starter's login, review the proposed files, and observe that no resources or Services
started. Then use an authenticated web app, capture base and after without disturbing its change,
ask for another capture, and inspect the files in Slack, inline media in T3 Code, Review, phone and
a landed PR. Check an unavailable base and a missing test account, a screen restart requiring
sign-in, retention beyond ordinary frame expiry, a later checkpoint, and a reader who loses change
access. Check external-provider session creation and password-account provisioning, a private GitHub
PR viewed by a repository reader without Mend access, refusal for someone without private-repo
access, and public PR images and video while signed out. Confirm that Mend revocation leaves already
delivered external copies under their destination's rules. The observations belong on the
implementation PRs under AGENTS.md, not on this unbuilt design.
