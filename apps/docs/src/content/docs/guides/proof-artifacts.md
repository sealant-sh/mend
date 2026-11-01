---
title: Review proof artifacts
description: Inspect screenshots and a short video of your web app on a session's screen.
sidebar:
  order: 1.5
---

:::note[Partly built] Captures, Slack file uploads and inline display in T3 Code are built. The
setup session, PR body embeds, the review page and the phone are not yet built. The first version
covers web apps. :::

A proof artifact is a selected screenshot or short video of your web app running on a session's
screen, attached to its change. You can inspect the captures without starting the app yourself. Its
label says what it shows, which source ran and when Mend observed it. A picture is evidence to
inspect, not a verdict that the change works.

## What a capture shows

Suppose an agent changes how your task board displays completed tasks. Mend labels the selected
screenshots and short video:

| Capture    | Label and source                                                                     |
| ---------- | ------------------------------------------------------------------------------------ |
| Screenshot | Completed task on board · checkpoint #2 · observed 17:58 UTC                         |
| Video      | Complete a task and reload the board · checkpoint `<checkpoint>` · observed `<time>` |

Open a screenshot to inspect the app with the change. Play the short video to see the flow, under
about 60 seconds. Each item links to the session and the moment or span in its screen log. Its
details name the recipe, source and known differences from the verification instructions. The
agent's caption describes what is visible; you decide what it establishes.

The agent chooses relevant captures using your
[feature map and verification instructions](/guides/setup-session/). You can ask for more in the
same session:

> Show the empty board too, then take another screenshot after signing in as the test account.

The new captures join the change without replacing earlier observations. If the worktree changes
again, an old capture keeps its original checkpoint label. It does not silently become evidence for
the newer code.

## Source and observation time

Captures show the app with the change as a person would see it. Mend takes a checkpoint when a
screenshot or video capture starts. Each label names that checkpoint and the time Mend observed the
screen. If checkpointing is unavailable, the label says `source unknown` and the metadata records
why. Later edits keep the capture's original label.

The agent uses `.mend/features.md` and `.mend/verify.md` when present, starts the app and opens it
on the session's screen. It records its launch command and any known differences from those
instructions. Labels describe observations, never verdicts. When the app cannot boot or a capture
cannot be taken, the agent records `proof_missing` with the reason. Missing credentials, unavailable
resources and incomplete video remain explicit.

## Apps that require sign-in

The [setup session](/guides/setup-session/) works out how to get a signed-in test user and writes
that procedure in `.mend/verify.md`.

For OAuth or another external provider, it studies your app's own session storage and writes a
script under `.mend/` that creates a valid test session in the app's development database or signs a
session cookie with the app's dev secret. The verification file says how to run it, which runtime
secrets and test data it needs, and how to put the session in the screen's browser. Captures skip
the provider's flow.

For password auth, the file names the seed script or documents the sign-up flow that creates the
test account. It gives the exact [project secret](/guides/environment-variables/) or Doppler names
and the command to set them. For example, an app using `TEST_USER_EMAIL` and `TEST_USER_PASSWORD`
can load them from a protected file outside the repo with
`mend env load /path/outside/repo/capture.env --secret --project task-board`, or upload them to
Doppler with
`doppler secrets upload /path/outside/repo/capture.env --project task-board --config dev`. The file
documents the app's actual names, seed or sign-up steps, and selected Doppler config.

No secret value, signed cookie or session token is written into `.mend/`. Scripts read their inputs
at runtime. Every screen has a fresh browser profile, discarded when it ends, so the agent repeats
this preparation after a screen restart. If a required secret or test user is missing, the capture
names that missing prerequisite.

Use test accounts and data suitable for the delivery audience. Screenshots and videos show the app's
visible account data; storing a login as a secret does not hide those pixels.

## Slack, T3 Code, phone and the landed PR

Mend uploads the screenshots and the video into the session's Slack thread as files. You see the
pictures and play the video there, with their source and observation captions. You can ask the
session for another capture using its normal steering permissions.

T3 Code shows the same images and video inline in the session's thread through Mend's T3 Code
gateway. You do not have to follow a link to Mend to see them. The planned phone review will show
the same screenshots, labels and video as the planned review page.

The planned landing delivery uploads the selected media as GitHub-native attachments to the PR's
repository. The PR body embeds the screenshots and a video player in Mend's section. It names the
source, observation time and landed checkpoint, and says when a capture comes from an older
checkpoint. Your text outside Mend's section stays intact. The design uses GitHub CLI's attachment
upload support, not a raw URL to a special Git ref. GitHub documents that readers of a private
repository can see its attachments; public-repository uploads need no authentication.

Anyone who can see the change can see its artifacts in Mend. Once posted, a copy lives in Slack, T3
Code or GitHub under that service's access rules. People with access there can see the delivered
media without Mend access; on a public repository anyone can see it. Yiannis has accepted this
publication behavior. Revoking access in Mend does not recall a copy already delivered elsewhere.

## What stays after the screen ends

Mend stores artifacts in its own blob store and keeps them as long as the change. Stopping the
workspace or removing the source session does not remove the change's selected captures.

A screen-log frame is one observation of the screen. Most frames never become proof artifacts, and
ordinary frames expire after 30 days under the screen design. Selecting a screenshot keeps its frame
for the life of the change. A video keeps its playable media and the source frames it needs.
Unrelated frames still expire, so the surrounding screen log can contain expired frames while the
selected artifact remains available. A frame that already expired cannot be recovered by selecting
it later.

## Remaining work

1. The setup session, including auth preparation.
2. Embedded media in the PR body.
3. The review page and phone presentation.

Withdrawing a capture is deferred to later work.
