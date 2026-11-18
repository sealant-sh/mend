# The report and its tickets

Step 7 of [SKILL.md](SKILL.md). Linear is the `linear_app.org.localLinearMcp` connection of the
Executor (team SLNT); the home repo's `linear` skill says how to work there.

## 1. Scan the evidence

```sh
node .agents/skills/verify/scripts/scan-evidence.mjs --dir $E --secrets $P --delete-hits
```

A screenshot that drive-web.mjs withheld, or the scan deleted, is named in the report, never posted.
Only what the scan passed leaves this machine.

## 2. The report

One comment on SLNT-1050, every line an observation in Mend's words ("seen", never "works"). Say how
the run was started only when the prompt that started you says it (the scheduled task's prompt
does); otherwise leave it out. A guess (on 18 Nov, "Started by hand" for a scheduled run) is not an
observation.

```markdown
**Main on the box · <commit:12> · <UTC date>**

Full CI: run <link> (dispatched by this run, `formal=full`) on <commit:12>, <conclusion>, <n> min.

- Jobs: <name · conclusion>, … (every job).
- Tests failed or retried: <package · file > name · outcome · ticket>, … (or none).
- Models at full bounds: <model · status>, … Build input probe: <conclusion>.

Box:

- Wait for the box: <h> h <m> min from the lock to the hold.
- Build: preview run <link>, version <version>, <n> min. Box: VM 131, was <version before>.
- Since <lastCommit:12>: <n> commits, PRs #a, #b, ….
- Free on `/`: <free before> → <free after> free. Removed: <what step 6 removed>.

| Flow           | Mode     | By        | Min | Outcome         | What was seen                                  |
| -------------- | -------- | --------- | --- | --------------- | ---------------------------------------------- |
| server.upgrade | agent    | Opus      | 9   | seen            | finished for <version>; the box runs this head |
| …              | scripted | Sol       | 2   | failed · SLNT-n | <the line that differed from "See">            |
| …              | agent    | Sol, Opus |     | seen            | <Opus re-saw it>                               |

- Who drove the flows: <n> by Sol subagents, <n> of them re-done by Opus; <n> by Opus. Model calls:
  Opus <n>, Sol <n> (from each thread's transcript or T3's task record; `not shown` when neither
  says).
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
   how often. A core flow failing on `main` usually meets Fix Now; a fault only this box's set-up
   can produce is File.
3. **Look for a twin.** Search SLNT's open tickets (any status but Done, Canceled or Duplicate) for
   the flow's id: `list_issues` with the id as the query finds it in a title or a description, and a
   ticket this check filed ends its title `(main on the box: <flow>)` or names the flow in its list.
   When one describes the same failure (the same part of the See line, the same words seen), it is
   that failure: comment one line on it (this run's commit, and anything that changed), file
   nothing, and write `failed · SLNT-n (known)` in the report's table. A ticket kept open as a
   product question (on 17 Nov, SLNT-1086 and SLNT-1087) counts the same way. File a new ticket only
   when no open ticket describes the failure, or the flow now fails a different way.
4. **File it:** project `CI follow-ups`, status `Todo`, assigned to Yiannis, label `mend`, related
   to SLNT-1050. The title is what a person saw, in the product's words, ending
   `(main on the box: <flow>)`. The body follows the `linear` skill's template, and its Notes hold
   the commit, the preview version, the PR and its overlap, the grade with its reason, and the
   evidence paths under `$E`.

Fix nothing; propose no fix beyond one sentence in the ticket.
