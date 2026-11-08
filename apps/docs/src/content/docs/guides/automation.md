---
title: Drive Mend from your own automation
description:
  Create an access key, then start, follow, stop, and land Mend sessions from a Slack bot, a CI job,
  or any script that speaks HTTP.
sidebar:
  order: 7
---

An access key lets your own automation call Mend's HTTP API as you, with no browser and no
`mend login`. A Slack bot, a CI job, or an internal "software factory" can use one to start a
session in conversation mode, send it follow-ups, read its change, and land it.

Every example on this page uses curl and `jq`, and reads two environment variables:

```sh
export MEND_URL=https://mend.example.com
export MEND_ACCESS_KEY=mak_<id>_<secret>
```

`MEND_URL` is the address you open the web app at. Every API path starts with `/api`.

## Create an access key

To create a key in the web app, open **Settings → Access keys**. Give the key a name the audit log
can show, such as `ci-bot`. Choose an expiry: 30 days, 90 days (the default), 1 year, or no expiry.

To create a key from a CLI signed in with `mend login`, run:

```sh
mend access-keys create ci-bot --expires 90d
```

Mend shows the key once, when it creates it, and keeps only its hash. Copy it into your automation's
secret store at that moment. A lost key cannot be read back. Revoke it and create another.

To see your keys, with when each was last used and when it expires, run:

```sh
mend access-keys list
```

Expired keys stay in the list until you revoke them, so you can see why a job stopped.

### What a key can do

A key acts as you, in the organization you were acting in when you created it, and never in another.
Switching organizations on the web or with `mend org switch` never moves a key, and a key cannot
switch, list, leave or join organizations itself. Leaving that organization, or being removed from
it, revokes the key; Mend also refuses it once your account is deactivated.

Everything else follows you. The key sees the projects you see. It steers the sessions you may
steer: your own, and others' where their owner turned on shared control. It lands only changes you
own. Your account and organization budgets apply to it, and each key also has a request budget of
its own. A turn the key sends spends your harness login, as a turn you send from the web app does.

A key cannot create, list, or revoke access keys, pair or revoke devices, approve a CLI sign-in, or
issue a password reset link. It also cannot create an invitation, add a workspace SSH key, or
confirm a Slack link, because each of those would let someone in after the key is revoked. Those
endpoints answer `403 AccessKeyRefused`. Do these from the web app or from a CLI signed in with
`mend login`.

The organization's audit log records each key's creation, its revocation, and its use, at most once
an hour. An action taken with a key names the key beside you: "Ana landed a change · access key
ci-bot".

## Send the key

Send the key in the `Authorization` header, and nothing else:

```sh
curl -sS -H "Authorization: Bearer $MEND_ACCESS_KEY" "$MEND_URL/api/projects"
```

Mend reads a key only from `Authorization: Bearer`. Never put a key in a URL, a query string, or a
cookie. Send no cookies and no `Origin` header with it. curl sends neither unless you ask it to.

The rest of this page uses a small shell function to save typing:

```sh
mend_api() {
	curl -sS \
		-H "Authorization: Bearer $MEND_ACCESS_KEY" \
		-H "Content-Type: application/json" \
		"$@"
}
```

## List your projects

`GET /api/projects` answers the projects your key can see:

```sh
mend_api "$MEND_URL/api/projects" | jq '.[] | {id, name, gitAuthMode, defaultBranch}'
```

Pick a project by name and keep its id:

```sh
PROJECT_ID=$(mend_api "$MEND_URL/api/projects" | jq -r '.[] | select(.name == "api") | .id')
```

## Find a model

`GET /api/harnesses/models` answers the server's model catalog. Each entry names a `harness`, its
`models` (each with an `id`, a `label`, `isDefault`, and the `efforts` it takes, or null for the
harness's own), its `defaultModel`, and the `efforts` the harness takes:

```sh
mend_api "$MEND_URL/api/harnesses/models" \
	| jq '.[] | select(.harness == "codex") | {defaultModel, efforts, models: [.models[].id]}'
```

Conversation mode runs `claude` and `codex`. Effort is one of `low`, `medium`, `high`, `xhigh`,
`max`, and `ultra`. Claude takes up to `max`, and Codex takes up to `ultra`. If you ask for a level
the model does not take, Mend runs the highest level it does. If you name no model, the launch runs
the catalog's `defaultModel`. Where `defaultModel` is `null`, as for `claude`, the harness picks its
own. The session records the model it ran.

## Start a session in conversation mode

Starting a session takes two calls: create the session in a project, then launch it.

### Create the session

`POST /api/projects/:id/sessions` creates the session and its worktree. The `name` field decides
which worktree the session runs in:

- A name no worktree has creates a new worktree on the branch `mend/<name>`. A name is lowercase
  letters, digits, `.`, `_`, and `-`, up to 64 characters.
- The name of an existing worktree joins it. The session becomes a new conversation beside the
  worktree's others, and contributes to the same change.
- `null` creates a worktree with a name Mend derives.

`base` is the branch or commit a new worktree starts from. `null` uses the project's default branch.
`label` is a name for the session, or `null`. `autoLand` is `true` or `false` to land after each
completed turn that asked for a change, or `null` to follow the project's setting.

```sh
SESSION_ID=$(mend_api -X POST "$MEND_URL/api/projects/$PROJECT_ID/sessions" \
	-d '{"harness": "codex", "name": "fix-retry-storm", "base": null, "label": null}' \
	| jq -r '.id')
```

The answer is the session. Keep its `id` and its `worktreeId`.

### Launch it

`POST /api/sessions/:id/launch` with `"mode": "protocol"` starts the agent as a conversation and
sends `prompt` as its first turn. `model` and `effort` are optional:

```sh
mend_api -X POST "$MEND_URL/api/sessions/$SESSION_ID/launch" -d '{
	"mode": "protocol",
	"prompt": "Retries in src/queue.ts never back off. Add exponential backoff and a test.",
	"model": "gpt-6.1-sol",
	"effort": "high"
}' | jq '{id, status, model, effort}'
```

Always send `"mode": "protocol"`. A launch without it starts a terminal session, which needs a
socket, and only the session's owner may run one.

The launch answers within 30 seconds. A launch that takes longer keeps going, and the answer is the
session as it stood then, often with `status` `starting`. Read the session until its status moves:

```sh
mend_api "$MEND_URL/api/sessions/$SESSION_ID" | jq '.session.status'
```

`status` is one of `starting`, `running`, `waiting`, `idle`, `stopping`, `completed`, `failed`, and
`stopped`. If your own HTTP client gives up on the launch first, read the session before you launch
again. A second launch over a live agent answers `409 SessionAgentLive`.

## Wait for a turn to end

`GET /api/sessions/:id/turns` answers the session's turns. The newest has the highest `ordinal`.
Each turn's `status` is one of `queued`, `running`, `completed`, `interrupted`, `failed`, and
`cancelled`.

This loop reads the newest turn every five seconds until it ends:

```sh
while :; do
	STATUS=$(mend_api "$MEND_URL/api/sessions/$SESSION_ID/turns" \
		| jq -r '(max_by(.ordinal) // {status: "queued"}) | .status')
	case "$STATUS" in
		queued | running) sleep 5 ;;
		*) echo "turn $STATUS"; break ;;
	esac
done
```

A turn can also wait on a person: an approval or a question from the agent. Read those with
`GET /api/sessions/:id/requests?pending=1`. Show each one to a person. Your automation must not
answer for them.

## Send a follow-up

`POST /api/sessions/:id/messages` sends words to the session. `input` is the text. `clientMessageId`
is a UUID you choose, so a retry with the same id replays the first answer instead of sending twice.
`resume: true` restarts a stopped conversation on its own harness and sends the words as its next
turn, in one request:

```sh
mend_api -X POST "$MEND_URL/api/sessions/$SESSION_ID/messages" -d "{
	\"input\": \"Also log each retry at debug level.\",
	\"clientMessageId\": \"$(uuidgen | tr 'A-Z' 'a-z')\",
	\"resume\": true
}" | jq '{_tag, explanation}'
```

Send `resume: true` unless you want a stopped session to refuse the message. Mend stops an idle
conversation's agent after a while, so a session you left alone may be stopped when you come back.
Without `resume`, such a session answers `409 ProtocolSessionNotLive`.

While a turn of yours is running, the message steers that turn and the answer's `_tag` is `Steer`.
Otherwise it starts a new turn and `_tag` is `Turn`. To ask for a new turn even while one runs, add
`"queue": true`. `explanation` says what Mend observed, such as
`sent as your next turn · you had no running turn in this session`.

## Read the session

These reads need no socket.

`GET /api/sessions/:id` answers the session under `session`, what you may do with it under
`control`, the worktree's `checkpoints` and `change`, and the change's `landings`:

```sh
mend_api "$MEND_URL/api/sessions/$SESSION_ID" \
	| jq '{status: .session.status, steer: .control.steer, change: .change.headSha}'
```

The conversation's history reads a window at a time, newest first. Each window answers `next`, the
cursor to pass as `before` for the next older window, or `null` at the start. `limit` is at most
100:

```sh
mend_api "$MEND_URL/api/sessions/$SESSION_ID/history/items?limit=100" | jq '.items[] | {kind, title, text}'
mend_api "$MEND_URL/api/sessions/$SESSION_ID/history/turns?limit=100" | jq '.turns[] | {ordinal, status, input}'
mend_api "$MEND_URL/api/sessions/$SESSION_ID/history/requests?limit=100" | jq '.requests'
```

### Follow events instead of polling

`GET /api/events` is a stream of server-sent events that accepts the same bearer key. Each event is
a small JSON pointer, such as `{"type": "agent-conversation", "sessionId": "…"}`, that says
something changed. It does not carry the new state. Read the session again when one names your
session:

```sh
curl -sSN -H "Authorization: Bearer $MEND_ACCESS_KEY" "$MEND_URL/api/events" \
	| grep --line-buffered '^data: ' \
	| while read -r _ event; do
		echo "$event" | jq -c "select(.sessionId == \"$SESSION_ID\") | .type"
	done
```

The stream carries only what your key can see. A `: ping` comment line arrives every 25 seconds.

## Read the change

The change is the session's worktree against its base. Mend takes checkpoints along the way,
including one at each turn boundary, and any two checkpoints define a slice you can read.

Get the worktree's id and its newest checkpoint from the session:

```sh
DETAIL=$(mend_api "$MEND_URL/api/sessions/$SESSION_ID")
WORKTREE_ID=$(echo "$DETAIL" | jq -r '.session.worktreeId')
TO=$(echo "$DETAIL" | jq -r '.checkpoints | max_by(.ordinal) | .id')
```

`GET /api/worktrees/:id/diff?to=<checkpoint>` answers the slice from the worktree's base to that
checkpoint. Add `from=<checkpoint>` to start the slice there instead, and `path=<file>` for one
file's patch:

```sh
mend_api "$MEND_URL/api/worktrees/$WORKTREE_ID/diff?to=$TO" \
	| jq '{fromSha, files: [.files[] | {status, newPath}], truncated}'
mend_api "$MEND_URL/api/worktrees/$WORKTREE_ID/diff?to=$TO" | jq -r '.diff'
```

When `truncated` is `true`, some files have no patch in `diff`. `omitted` lists them, and
`listingCut` says the slice may hold more files than `files` lists. Ask for each by `path`.

`GET /api/worktrees/:id` answers the worktree with its whole checkpoint chain, its change, and every
session in it.

## Stop the session

`POST /api/sessions/:id/stop` stops the agent. The session keeps its record, its worktree, and its
change. The answer is the session:

```sh
mend_api -X POST "$MEND_URL/api/sessions/$SESSION_ID/stop" | jq '.status'
```

To continue later, send a follow-up with `resume: true`.

## Land the change

Only the change's owner lands it. The owner is the person who started the first session in the
worktree. A key lands a change only when that person is you. Anyone else's key answers
`403 LandingNotAllowed`.

`POST /api/sessions/:id/land` commits what the worktree holds, pushes it to a branch on origin, and
opens or updates a GitHub pull request. Every body field is optional. `branch` names the branch on
origin. `null` keeps the branch the change last pushed to, else `mend/<name>`. `pullRequest: false`
pushes without a pull request. `title` and `body` are the pull request's:

```sh
mend_api -X POST "$MEND_URL/api/sessions/$SESSION_ID/land" -d '{"title": "Back off queue retries"}' \
	| jq '{outcome: .landing.outcome, pushed: .landing.pushedSha, pullRequest: .pullRequest}'
```

`landing.outcome` is one of `pushed`, `pull-request`, `refused`, `failed`, and `adopted`.
`landing.message` carries the remote's or GitHub's own words for a refusal or a failure.
`pullRequest._tag` says how the pull request step went: `opened`, `updated`, `off`, `unavailable`,
`failed`, or `not-reached`. When it opened or updated one, `pullRequest.pullRequest` holds its
`number`, `url`, and `state` as GitHub last reported it. Mend never merges.

A project with `gitAuthMode: bridge` signs its pushes through the SSH agent that a `mend` command on
your machine shares. While no machine shares one, the landing's push fails and says so, so an
automation cannot land such a project by itself. Land those from the web app or with `mend land`
while your CLI is connected. Read [Git access](/guides/git-access/#ssh-agent-bridge).

Read more in [Land a change](/guides/land-a-change/).

## Revoke the key

To revoke a key, open **Settings → Access keys** in the web app, or run:

```sh
mend access-keys revoke <id>
```

`<id>` is the id `mend access-keys list` shows. The next request that presents the key answers
`401`:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
	-H "Authorization: Bearer $MEND_ACCESS_KEY" "$MEND_URL/api/projects"
```

Revoking a key also ends every upgrade ticket and preview grant it minted.

## Errors you may see

An API error answers a JSON body whose `_tag` names it.

| Status | `_tag`                       | What it means                                                                                                                                                        |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `Unauthorized`               | The key is missing, malformed, revoked, or expired, or you are no longer a member of its organization.                                                               |
| 403    | `AccessKeyRefused`           | The endpoint creates or manages credentials. Use a sign-in or `mend login` instead.                                                                                  |
| 403    | `SessionNotSteerable`        | You may see the session but not steer it. `message` says why.                                                                                                        |
| 403    | `LandingNotAllowed`          | You do not own the change.                                                                                                                                           |
| 404    | `NotFound`                   | The project or session does not exist, or you cannot see it. Mend answers both the same way.                                                                         |
| 409    | `ProtocolSessionNotLive`     | The conversation is stopped. Send the message again with `"resume": true`.                                                                                           |
| 409    | `SessionAgentLive`           | A launch found an agent already running in the session.                                                                                                              |
| 409    | `AccessKeyNeedsOrganization` | Creating a key: you belong to no organization, so there is none for the key to act in.                                                                               |
| 429    | `BudgetExceeded`             | A budget refused new work. Nothing running stopped. `budget` names which one. Wait `retryAfterSeconds`, or the `Retry-After` header's seconds, before you try again. |
