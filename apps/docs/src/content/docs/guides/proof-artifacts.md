---
title: Review proof artifacts
description:
  Inspect before and after screenshots and a short video of your web app on a session's screen.
sidebar:
  order: 1.5
---

:::note[Agreed design, not yet built] This guide describes recorded proof artifacts designed for
Mend 0.37. The captures and review controls described here are not yet built. The first version
covers web apps. :::

A proof artifact is a selected screenshot or short video of your web app running on a session's
screen, attached to its change. You can inspect it beside the diff without starting the app
yourself. Its label says what it shows, which source ran and when Mend observed it. A picture is
evidence to inspect, not a verdict that the change works.

## What you see in Review

Suppose an agent changes how your task board displays completed tasks. The review page keeps the
diff primary and shows **Proof artifacts** beside it:

| Capture           | Label and source                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Before screenshot | Completed task on board · before · base `<commit>` · observed `<time>`                       |
| After screenshot  | Completed task on board · after · checkpoint `<checkpoint>` · observed `<time>`              |
| After video       | Complete a task and reload the board · after · checkpoint `<checkpoint>` · observed `<time>` |

Open the paired screenshots to compare them. Play the short video to see the after flow, under about
60 seconds. Each item links to the session and the moment or span in its screen log. Its details
name the recipe, source and known differences in test data. The agent's caption describes what is
visible; you decide what it establishes.

The agent chooses relevant captures using your
[feature map and verification instructions](/guides/setup-session/). You can ask for more in the
same session:

> Show the empty board too, then take another screenshot after signing in as the test account.

The new captures join the change without replacing earlier observations. If the worktree changes
again, an old capture keeps its original checkpoint label. It does not silently become evidence for
the newer code.

## Where before and after come from

Before runs the app's recipe at the change's base commit in a side copy on another port. The agent
opens that app on the session's screen. It never checks out the base over your working files or
resets your change.

The side copy uses separate writable data. For Postgres, that means a temporary worktree with its
own database on the project's server. Other resources use worktree instances where the flow writes
to them. The agent starts these explicitly and cleans up only what it started. Declaring a resource
or starting a session does not perform its first start. See [Resources](/guides/resources/).

After runs the app at a pinned checkpoint. If other sessions are still editing the worktree, the
agent uses a copy of that checkpoint too. It tries to use the same route, viewport, account role and
starting fixtures for both captures, and records differences. "Before" means base source; it does
not mean the screenshot was necessarily taken earlier.

If the base has no recipe, the agent records the launch command it used instead. If the base cannot
run, you see `before · not captured` and the reason. Missing credentials, unavailable resources,
incomplete video and unknown source are stated too. A missing image is never filled with an after
image labelled before.

## Apps that require sign-in

Provide a project test account through [project secrets](/guides/environment-variables/) or Doppler.
The [setup session](/guides/setup-session/) assesses the auth flow and writes the required variable
names, test-account permissions and data needs into `.mend/verify.md`. Credentials stay out of those
files and the capture captions.

The agent signs in through your app. Every screen has a fresh browser profile, discarded when it
ends, so signing in must happen again after a screen restart. Mend does not restore your personal
browser cookies. If an external provider, email link or one-time code needs your help, the agent
says which step is missing. Without the needed account, the capture reads
`not captured · test account needed`.

Use an account and test data suitable for everyone who can see the change. Screenshots and videos
show the app's visible account data; a secret-backed login does not hide those pixels.

## Slack, phone and the landed PR

The phone's review shows the same screenshots, labels and video. The Slack thread shows captions and
authenticated links to open the captures. You can ask the session for another capture from there
too, using its normal steering permissions.

When the change's owner lands it, Mend adds labelled screenshot and video links to its section of
the PR body, along with the source and observation time. It names the landed checkpoint and says
when a capture comes from an older checkpoint. Your text outside Mend's section stays intact. Review
and captures are useful before you choose to land anything.

Anyone who can see the change can see its artifacts. Slack channel membership or GitHub access alone
does not grant access to Mend. Links require Mend sign-in and access to the change, and the reader
must be able to reach your instance. This design uses links rather than automatically uploading
media to Slack or GitHub. Broader publication is an open product question.

## What stays after the screen ends

Mend stores artifacts in its own blob store and keeps them as long as the change. Stopping the
workspace or removing the source session does not remove the change's selected captures.

A screen-log frame is one observation of the screen. Most frames never become proof artifacts, and
ordinary frames expire after 30 days under the screen design. Selecting a screenshot keeps its frame
for the life of the change. A video keeps its playable media and the source frames it needs.
Unrelated frames still expire, so the surrounding screen log can contain expired frames while the
selected artifact remains available. A frame that already expired cannot be recovered by selecting
it later.
