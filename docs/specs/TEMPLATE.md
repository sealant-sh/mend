# <Feature name>

- **Release:** 0.36
- **Status:** on main | in review | designed | planned. Use the commit or PR state at the time of
  writing.
- **PRs:** mend#…, sealant#…, sealantd#…
- **Decision records:** docs/adr/00NN-….md, if any.
- **Written:** 2026-10-05, against mend main `<sha>`, sealant main `<sha>`, sealantd main `<sha>`.

## Why it exists

The problem a person had before this feature, in their terms. Who hits it and how often. What it
cost them: time, lost work, a leaked credential, confusion. Link the owner decision or incident if
there is one.

## What it does

The behaviour a person can see, stated as facts:

- what they do;
- what Mend does;
- what they see (exact UI or CLI wording where it matters);
- defaults, and which settings change them.

**In scope.** A bulleted list.

**Out of scope.** What this feature deliberately does not do, so a reviewer does not report it as a
bug.

## How it works

The mechanism, end to end, in the order things happen. Name the components (Mend API, session
engine, CLI, web, mobile, Core worker or API, sealantd), the data they write (tables and columns,
files and paths, capture classes) and the calls between them. Give code pointers as `path:line`
against the commits above, and enough for a reviewer to find every place the behaviour lives. Note
concurrency, ordering and what happens on restart.

## Happy path

A concrete user story, step by step, with named people (for example Alice and Bob), real-looking
inputs and what each person sees at each step. It should be specific enough that someone could run
it on the box and say "yes, it did exactly that".

## Invariants

Statements that must ALWAYS hold. Number them, and make each one testable and falsifiable. These are
what an adversarial reviewer tries to break, for example:

1. One person's credentials are never readable by, spent by, or restored to another person.
2. No step deletes a person's work product; anything set aside is moved, never removed.

## Edge cases and failure behaviour

For each case, the expected behaviour: what Mend does and what the person sees. Cover:

- concurrent actions;
- restarts mid-operation (the Mend server, the executor, sealantd);
- partial failures;
- missing or odd input;
- older data from before this feature;
- permissions: owner, member, steerer, operator;
- every client: web, CLI, desktop, mobile, VS Code, Slack, t3 gateway, wherever the feature reaches.

## Known limits

Accepted, documented limitations, with links to Known issues or the ADR. A reviewer should not
report these as new findings unless the code is worse than described.

## How to verify

- The existing tests that cover this (file paths), and what they do not cover.
- How to exercise it by hand on the box, with commands.
- Signals to watch: log lines, session status words, metrics.

## Divergences found while writing

Places where the code does not match the intended behaviour above, or where the intent is unclear.
Each one gets a file:line and a one-line description. Do not fix code here; this is input for
review.
