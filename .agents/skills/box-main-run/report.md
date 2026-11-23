# The report and its tickets

Step 7 of [SKILL.md](SKILL.md). Linear is the `linear_app.org.localLinearMcp` connection of the
Executor (team SLNT); the home repo's `linear` skill says how to work there.

## 1. Scan the evidence

```sh
find $E/start-session.new-web-streaming -mindepth 1 -maxdepth 3 -type d \( -name local -o -name remote -o -name scroll \) -prune -exec rm -rf {} +
node .agents/skills/verify/scripts/scan-evidence.mjs --dir $E --secrets $P --delete-hits
```

The first line removes the streaming recipe's screencast frames once that flow is judged: no driver
checks them, so the scan deleted each one as a hit (3 893 of 22 Nov's 3 915, 2 692 of 23 Nov's 3
927), and the hits that matter were lost among them. The recipe writes them into one directory per
turn (`local`, `remote`, `scroll`) under `STREAM_OUT`, whatever a subagent named that (`samples` on
22 Nov, `raw-stream` on 23 Nov, or `opus/…` for a second look), so the line finds them by those
names and keeps the `<turn>.json` numbers beside them.

A screenshot that drive-web.mjs withheld, or the scan deleted, is named in the report, never posted.
Only what the scan passed leaves this machine.

## 2. The report

One comment on SLNT-1050, every line an observation in Mend's words ("seen", never "works"). Say how
the run was started only when the prompt that started you says it (the scheduled task's prompt
does); otherwise leave it out. A guess (on 18 Nov, "Started by hand" for a scheduled run) is not an
observation.

```markdown
**Main on check VMs · <commit:12> · <UTC date>**

Full CI: run <link> (dispatched by this run, `formal=full`) on <commit:12>, <conclusion>, <n> min.

- Jobs: <name · conclusion>, … (every job).
- Tests failed or retried: <package · file > name · outcome · ticket>, … (or none).
- Models at full bounds: <model · status>, … Build input probe: <conclusion>.

Check VMs:

- Length: <h> h <m> min from the lock to the next master built (or to the save, with why it was not
  built). Wait for room: <m> min from the lock to lane A's copy. Flows: <m> min from the first
  flow's start to the last flow's end (150 min on 23 Nov), and each lane's own beside 23 Nov's and
  the split's estimate: A <m> (115; about 121), B <m> (142; about 124), C <m> (146; about 121), each
  with its minutes between flows and its number of subagent runs. Warm-up: <SKILL.md step 6's line>.
- Build: preview run <link>, version <version>, <n> min. Copies booted from the master
  <master version>; lanes A (copy <n>, Boat), B (copy <n>), C (copy <n>, Boat or no Boat), or the
  lanes left out.
- Since <lastCommit:12>: <n> commits, PRs #a, #b, ….
- Flows: <n> seen, <n> failed, <n> not run (<reasons with counts>).
- Logins: Codex <refreshed on lane A at <UTC> · held | not due (expires <UTC>) · held>; Claude <…>.
  While Claude's reads `invalid · refused`:
  `Claude refused by the provider, left so by the owner's choice (SLNT-1219)`, and nothing filed for
  it. Saved: `vm save` <UTC>, <sizes>. Next master: <version>, built <UTC>, or why not.
- Free on lane A's `/`: <free before> → <free after>.

| Flow           | Lane | Mode     | By        | Min | Outcome         | What was seen                                  |
| -------------- | ---- | -------- | --------- | --- | --------------- | ---------------------------------------------- |
| server.upgrade | A    | agent    | Opus      | 9   | seen            | finished for <version>; the box runs this head |
| …              | B    | scripted | Sol       | 2   | failed · SLNT-n | <the line that differed from "See">            |
| …              | C    | agent    | Sol, Opus |     | seen            | <Opus re-saw it>                               |

- Who drove the flows: <n> by Sol subagents (<n> subagent runs), <n> of them re-done by Opus, each
  named with why; <n> by Opus.
- Second looks: <n> failures seen again by Opus on their lane before its copy went; <n> needing
  none, as `Waiting on` (<ids>) or a twin (<ids>); <n> without one because of the run cap (<ids>).
- Not on the box by design: flows.md, "Not on the box".

<screenshots, one per web flow, the state a person saw>
```

Screenshots go into the comment one at a time, in two calls with nothing between them: Linear's
signed URL expires 60 seconds after `prepare_file_upload` answers.

1. `prepare_file_upload` with the file's name, `image/png` and its size in bytes (`stat -c %s`).
2. At once, pipe its answer, exactly as it came, into the helper:

   ```sh
   .agents/skills/box-main-run/upload-screenshot.sh <png> <<'JSON'
   <prepare_file_upload's answer>
   JSON
   ```

   It sends every header verbatim and prints the markdown to put in the comment. On 17 Nov the PUT
   landed 9 seconds after the URL was signed. A refusal (400 or 403) means the URL expired: prepare
   again.

## 3. A ticket per failure

For each `failed` flow, for a failed build, deploy or identity, and for each failed job or test of
the full CI run (after linking the failed-tests watch's ticket when it has one):

1. **Name the PR.** Of the PRs merged since `lastCommit`
   (`git log --first-parent --format='%h %s' <lastCommit>..$SHA`), the one whose files most overlap
   the flow's "Areas" (`git show --stat <commit>`). Name it with the overlap ("#1720 changed
   `packages/sessions/src/launch.ts`"). When none overlaps, say so and name none: an older cause is
   likely.
2. **Grade it** by Fix Now or File (the home repo's `AGENTS.md`): what a person does to hit it and
   how often. A core flow failing on `main` usually meets Fix Now; a fault only a check VM's set-up
   can produce is File.
3. **Look for a twin.** A flow whose `Waiting on:` line (flows.md) names the part of the See line it
   fell short on has its twin already: comment on that ticket only when the flow failed another way
   too. Otherwise search SLNT's open tickets (any status but Done, Canceled or Duplicate) for the
   flow's id: `list_issues` with the id as the query finds it in a title or a description, and a
   ticket this check filed ends its title `(main on the box: <flow>)` or names the flow in its list
   (tickets from before 21 Nov 2026 say `on the box`; later ones say `on check VMs`). When one
   describes the same failure (the same part of the See line, the same words seen), it is that
   failure: comment one line on it (this run's commit, and anything that changed), file nothing, and
   write `failed · SLNT-n (known)` in the report's table. A ticket kept open as a product question
   (on 17 Nov, SLNT-1086 and SLNT-1087) counts the same way. File a new ticket only when no open
   ticket describes the failure, or the flow now fails a different way.
4. **File it:** project `CI follow-ups`, status `Todo`, assigned to Yiannis, label `mend`, related
   to SLNT-1050. The title is what a person saw, in the product's words, ending
   `(main on check VMs: <flow>)`. The body follows the `linear` skill's template, and its Notes hold
   the commit, the preview version, the flow's lane, the PR and its overlap, the grade with its
   reason, and the evidence paths under `$E`.

Fix nothing; propose no fix beyond one sentence in the ticket.
