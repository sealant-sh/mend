# Evidence and the proof rules

`pnpm verify evidence` scans and writes the verdict file. Read this for where each artifact goes,
what makes a proof, and why a screenshot is withheld. In this file, Launch is `pnpm verify stack up`
and Cleanup is `pnpm verify stack down`. `$E` is the run's evidence directory, `$P` its private
directory, `$wt` its outer worktree and `$web` its tunnel; `.verify/stack/current.json` names each
for the run that is up.

Everything goes under `$E`, on this machine, outside any checkout and outside the stack's session.
Cleanup removes neither. Name each directory for the feature file and the entry point:
`$E/adopt-project/web`, `$E/adopt-project/cli`.

| What                     | How                                                                                                                                                                                                | Where                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| ARIA snapshot            | `capture(name)` in a recipe: `page.locator("body").ariaSnapshot()`, redacted                                                                                                                       | `<dir>/<name>.aria.yml`                                   |
| screenshot               | the same `capture(name)`, full page, heading in view, every canvas masked; withheld on a page that shows a credential                                                                              | `<dir>/<name>.png` and `.png.checked`, or `.png.withheld` |
| web steps                | `note(text)`, and every capture and failure                                                                                                                                                        | `<dir>/steps.log`                                         |
| CLI stdout, stderr, exit | `node $skill/scripts/steps.mjs <dir> <batch> …` (inner steps) or `capture.sh <dir> <step> -- <command…>` (one command), redacted                                                                   | `<dir>/<step>.{cmd,stdout,stderr,exit}`                   |
| the stack                | the doctor, and once more before Cleanup: `doctor.mjs … --out "$E/final"`                                                                                                                          | `report.json`, `images.json`, `doctor.txt`                |
| the inner record         | before Cleanup: `stack.mjs mend sessions --all --json` through `capture.sh`, and the inner session page through `capture()`; `stack.mjs mend logs <id>` once the Mend under test has it (mend#610) | `$E/<feature>/cli`, `/web`                                |
| the outer record         | each `mend run` prints `session <id8>` on stderr; the outer server keeps those records after Cleanup: `mend logs <id8>`                                                                            | `<step>.stderr`                                           |
| a Stop that stays saving | `settle.mjs` (Cleanup): the session's last state, and the outer server's logs with its `capture seals` lines                                                                                       | `$E/cleanup/settle/`                                      |

The inner record lives in the stack and goes with it, so capture it before Cleanup. A proof follows
the map's proof rules:

- **The real user path.** Use the web through its controls and the CLI through its commands. Test
  endpoints and internal setters are not the user's path.
- **The action and its result.** Capture before and after, not only the last screen.
- **Side effects, seen a second time.** A reload, or a listing command (`mend projects`,
  `mend sessions --all --json`, `mend worktrees --json`) after a mutation.
- **The record of each artifact:** the feature file, the sub-feature ID, and the entry point (web or
  CLI).
- **Unreachable, said as such:** the step tried and the precondition missing ("provider not
  connected", "origin is not on GitHub"). An entry point proven through another is not proven.
- **Mocks only at a production boundary.** The stack's fixture git server stands in for a git host;
  Sealant, the database and the web are the real ones, built from source. A dry run is verified by
  observing what it skipped (files, git refs, network), not by its name.
- **No credential in the evidence, checked.** Every output path (snapshots, screenshots, steps, CLI
  transcripts, errors, server logs) is redacted twice: by value, against the run's secret registry
  (the handed-over account, the browser's cookies, the handover key, everything typed or minted,
  line by line and encoded), and by shape, against `redact.mjs` (invitation and reset links, device
  tokens, pairing codes and links, bearer tokens, signed URLs, private keys, provider keys,
  credential fields). A page that shows a credential (a field a secret was typed into, a QR code, a
  pairing code, a minted token), in its ARIA snapshot or anywhere in its text (`aria-hidden`
  included), keeps only its redacted snapshot, every credential field's subtree included:
  `<name>.png.withheld` says why. Canvases, videos, embedded objects and child frames withhold the
  whole image, including ordinary content: Playwright's masks themselves create closed roots, and
  the driver cannot safely exempt them by a page-spoofable name. Terminal and canvas-heavy views
  retain redacted ARIA evidence but lose image evidence until retained-image support can enforce
  masking without exempting unchecked content. Chromium DOM metadata checks the main document's
  author-created closed shadow roots before and after capture, including roots present before
  `--cdp` attachment. A closed root or unavailable inspection withholds the whole image; native
  user-agent roots do not. A CDP event latch also withholds if an author closed root appears during
  capture, even if removed before the final check. A document reset or inserted subtree whose event
  omits its descendants makes inspection unavailable and also withholds, including ordinary dynamic
  content. That latch conservatively includes roots added in child documents on the same target; a
  child frame already withholds its image. Screenshot bytes stay in memory until these checks
  finish, and reusing a capture name clears its prior image and sidecar. A kept screenshot gets
  `<name>.png.checked` with its digest. These DOM checks do not OCR arbitrary pixels; the digest
  records the driver's capture checks, not a general proof that an image contains no secret. No
  trace, HAR or video is recorded. Cleanup's scan searches every file of `$E` for every registered
  value and every shape, and counts as a hit an archive and any image without a matching `.checked`
  (one a recipe saved itself, or changed since): a hit fails the run. What the registry takes from
  the browser state is the cookies and the credentials a page stores (a token under a secret key, an
  item named for one, a value shaped like one), not its preferences or the project ids it remembers;
  from a JSON login (`auth.json`), its tokens and the whole text, not its account id. The skill's
  fake logins (`fakes.mjs`) are never a hit.
