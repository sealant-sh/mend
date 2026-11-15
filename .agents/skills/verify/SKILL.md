---
name: verify
description:
  "Prove a change to Mend works, with evidence: what it owes, the pre-PR gate, the models, a full
  stack (sealantd, sealant and Mend built from source) driven through its web, CLI and clients, and
  the preview server's setup. Use before a PR, to prove a change to Mend's web, CLI or clients
  works, before a feature or fix merges, or to verify a PR that spans Mend, sealant and sealantd."
---

# Verify Mend

Verifying is climbing a ladder of `pnpm verify` verbs, as far as the change needs. Each prints one
result (`--json` for the JSON alone), keeps it in `.verify/latest/<verb>.json` tied to the commit
and whether the tree was dirty, and lists in `next` the commands that would turn a result that did
not pass into one that does. Run them; read their `steps`, `obligations` and `next`.

Every proof line is an **observation**: what was run, what was seen, where it is kept ("inner
session bb2cdbf7 · completed · observed"). Write observations; leave verdicts ("works", "passes",
"safe", "ready to merge") to the person reading them.

A skip is never a pass: a step that did not run is `skipped`, `blocked_by_prerequisite`,
`not_implemented` or `requires_external_observer`, and says why. Report it with that word.

## 1. Plan

```sh
pnpm verify plan              # or --files <paths…> to ask about paths without a diff
```

It reads the diff against `origin/main` (uncommitted files included) and says what it owes: the
pre-PR checks, gated suites, models (`formal-<area>`), for product source a judgement and a run of
the change (`judge`, `run-it`), screenshots, and which CI jobs the PR will run. The map is
`tooling/verify/obligations.json`; models come from `docs/formal/<area>/COVERAGE`. **Done when** you
know each obligation's command. Climb only as far as they reach.

## 2. Check

```sh
pnpm verify check             # --concurrency 2 on a shared, busy machine
```

AGENTS.md's gate before a PR: forced typecheck and lint, the affected packages' tests, the format
check. A test that skips makes it `skipped` unless `tooling/verify/allowed-skips.json` allows that
skip and the plan does not owe its gate. Each entry says where that test does run (a CI job and
step, which a test holds to `ci.yml`, or no CI job), and the receipt's `pre-pr-checks` line counts
the skips by where they run. A gate this machine can set safely, such as Doppler's when `doppler` is
on PATH, it sets itself. A test file that took a quarter of CI's per-file limit here is a named
warning (`warnings` in the result, and on the receipt line), never a failure: measure it under
`stress-ng`, split it, or move a long exploration to its own job. With no Postgres it is blocked and
names the compose command. **Done when** it passes on the commit you push.

## 3. Models

```sh
pnpm verify formal            # --full for the full bounds
```

Owed when the change reaches code a model covers. It runs `check.sh --quick`, fails a change to
covered code that moved neither the model nor `COVERAGE`'s sync commit, and reports drift since the
sync. The area's skill (`.agents/skills/<area>`) says how to decide whether the model still
describes the code, and how to move the sync. CI's `formal` job runs the same.

## 4. Judge

```sh
pnpm verify judge                         # writes .verify/judge/<sha12>/brief.md
pnpm verify judge --record <answer.json>  # keeps the other agent's answer for this commit
```

Owed by a feature or fix, once the change is committed and before you run it. How it is proved is
not yours to decide: start one agent that did not write the change, give it the brief and nothing
else, and save the JSON it replies with. In Claude Code that is one `Agent` call whose prompt is
"Read `<brief path>` and do what it asks"; in Codex, one `spawn_agent`. Any summary or opinion you
add makes the judge agree with you.

The answer says where to run it (`local`, or `box` with the limit from
`tooling/verify/local-stack-limits.json` that applies), three to five things a person must see, and
what they would see if it did not work. `--record` refuses an answer that is not in that shape, and
a `local` answer for a file only the box can show. The receipt's `judge` line carries the answer's
reason. With no way to start another agent, answer the brief yourself and add `--self`; the receipt
says so. **Done when** `pnpm verify judge` reads `passed` for the commit you will push.

## 5. Run it

A stack is a real Mend, built from source, running in one Mend session (the **outer** session) on an
outer server. The outer server is a `local-outer.sh` server on this machine, or the box when its
operator says so. Set it up once per machine: [references/outer.md](references/outer.md).

```sh
.agents/skills/verify/scripts/local-outer.sh up
export MEND_VERIFY_MACHINE_XDG=${XDG_CONFIG_HOME:-} XDG_CONFIG_HOME=~/.cache/mend-verify/outer-cli \
  MEND_VERIFY_OUTER_URL=http://127.0.0.1:23105
pnpm verify stack up          # --mend|--sealant|--sealantd <source>, --expect-mend <sha>, --port
```

`up` takes a slot (at most 4 stacks live and 2 building per machine), starts the outer session and
the stack's Service, tunnels its web to `localhost:<port>`, hands its first account over sealed, and
runs the doctor. It is `passed` only when the doctor is: this run's tunnel and build, healthy now,
an inner `mend` signed in, and the commits you named. Use `--sealant pinned --sealantd pinned`
unless the change needs their `main`. `pnpm verify stack status` runs the doctor again.

Why it is built this way, which you keep to when you go past the verbs:

- **The guard.** Every `mend` and driver of a run passes `scripts/guard/`, which refuses any server
  but the declared outer one and the run's own tunnel, and every config, login or keyring of this
  machine's. It is what keeps a run off the owner's Mend: run helpers through it, never around it
  ([references/guard.md](references/guard.md)).
- **Only what the run made.** Drive the stack, tunnel and sessions this run recorded; never another
  verifier's `st-verify-` session.

## 6. Drive

The feature map, `features/` beside this file (`features/README.md` its index), says per feature
what to do on each surface and what proves it. Drive a recipe with the surface's own driver:

```sh
pnpm verify drive web --recipe web-projects        # a checked-in recipe, or a path to yours
pnpm verify drive <desktop|mobile-web|vscode|t3> --recipe <name|path>
```

Output goes to the run's evidence directory, `<evidence>/<recipe>/<surface>`. A surface with no
recipe answers `not_implemented`; the terminal always does, so drive it with `drive-tui.sh`.

- Writing a web recipe or a CLI batch (`steps.mjs`), credentials and fake logins, the map's
  placeholders, and the steps this skill does not run:
  [references/recipes.md](references/recipes.md).
- The terminal, desktop, mobile web and T3 drivers:
  [references/surfaces.md](references/surfaces.md).
- VS Code, which runs against a world of its own: [references/vscode.md](references/vscode.md).

Capture the inner record (sessions, the session page) before step 8: it goes with the stack.

## 7. Evidence

```sh
pnpm verify evidence
```

It takes this head's drives (clean tree only), runs the secret scan over the run's evidence, and
writes `.verify/evidence/<sha12>/verdict.md`: the build, what was driven and captured, the scan, the
obligations. Write its "What I saw" and "Not checked" yourself, as observations. A scan hit deletes
the file and the result is `evidence_withheld`: report it as such. The proof rules and why a
screenshot is withheld: [references/evidence.md](references/evidence.md).

The verdict file lists what the judge asked for under "What I saw": answer each line. Once
`evidence` passes on the commit you push, the receipt's `run-it` line reads `passed` (AGENTS.md, Run
a Feature Before It Merges). Post the verdict on the PR yourself. Nobody repeats the run. A change
you could only drive with `drive-tui.sh` has no drive result, so its line stays `skipped`: name it
under the receipt with the transcript.

## 8. Down

```sh
pnpm verify stack down
.agents/skills/verify/scripts/local-outer.sh down   # when you made the outer for this run
```

It removes only what the run recorded, waits until the outer session has saved, scans the evidence
and removes the private registry. The outer worktree stays: it holds the record. A Stop that stays
saving, what the teardown leaves, and a retry in the same session:
[references/cleanup.md](references/cleanup.md).

## 9. The box, when the judge says so

The box is our preview Mend server. A change goes there when its judge answered `box`, or when the
owner asks (AGENTS.md, The Box). You run it there yourself, and see what the judge listed. The setup
is commands:

```sh
export MEND_VERIFY_BOX_SSH='-J root@<proxmox host> root@<box vm>'
pnpm verify box plan --pr <n>       # what it runs, whether another check holds it, schema, disk
pnpm verify health                  # from where its app URL answers: here, its host, a container
pnpm verify box prepare --pr <n> --yes
pnpm verify box cli --pr <n> --yes
# build and deploy the preview: docs/operations/preview-builds.md
pnpm verify box identity            # by patch id, the running build contains this change
pnpm verify box release --pr <n> --yes
```

`run-it` reads `passed` once `box identity` passes on the commit you push. Use the box through the
`mend` CLI and browser already signed in there. Never sign that CLI in or out, and never read its
token. A schema the box applied that this head lacks blocks `plan`: deploy a build that contains it.
When the box's own health wait fails while `health` says the server answers from here, the box
cannot resolve its own app URL; that is the fixture, not the change.

## Report

One block per run, every line an observation:

- **Run:** the worktree, the outer server and its version, and the evidence directory.
- **Refs and daemon:** the doctor's source lines (Mend, sealant, sealantd commits) and its
  `workspace sealantd · <version>`.
- **Launch:** cold or warm, the time to ready, the check's outcome.
- **Per feature and entry point:** observed, with its artifacts, or `not run · <reason>`. Both
  surfaces' account.
- **Cleanup:** what `down` removed, the session's state, the scan's result.
- **Receipt:** `pnpm verify status --markdown`, one line per obligation for this exact commit.
