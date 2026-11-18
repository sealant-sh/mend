# Sheet: Mend's design language

Version 4.0, 18 November 2026. Applies to the new web app (`apps/web`, `@mend/web`) and its UI kit
(`packages/ui`, `@mend/ui`). Sheet was chosen on 14 November 2026.

The desktop app, the marketing site, the mobile app, the VS Code extension, the old web app
(`apps/web-old`) and everything else on the old kit (`@mend/ui-old`) still follow Evidence Review
until each is redone. Its text is
[`docs/design-evidence-review.md`](docs/design-evidence-review.md), unchanged and with the same
section numbers, so a code comment in those apps that cites "`DESIGN.md` §4" means §4 of that file.

## Where the truth lives

- **Screens, and every state of each one:** the Doop canvas "Mend" (`eOZgbKdtRc`). Its style guide
  is `mend-system`. The flow pages 1 to 8, "Sessions sharing a workspace", "Session layouts · Tabs
  and tiles" and the Components page are the spec.
- **Values** (colours, radii, shadows, sizes): `packages/ui/src/styles/globals.css`, light in
  `:root` and dark in `.dark`. This file names tokens and says what each is for. It gives a size
  only to help you match a frame, and never a colour value.
- **Primitives:** `packages/ui/src/components/ui/`, shadcn's `base-nova` style on Base UI with
  Lucide icons. `pnpm --filter @mend/ui gallery` shows each one in every variant, in light and dark
  and at 390px.
- **What is enforced:** Mend's lint rules, `tooling/oxlint-plugin-mend`, set for `apps/web` and
  `packages/ui` in `.oxlintrc.json`. Its README says what each rule flags.
- **Why the product behaves as it does:** [`docs/decisions.md`](docs/decisions.md) and
  [`docs/adr/`](docs/adr/).

The canvas pages "Foundations", "Information architecture", "Visual identities", "Sheet, Graphite,
Night", "Flows · Sheet + Lump" and "Session layouts · A/B" are past explorations. Read them for
background, never as a spec. A frame that breaks a rule in this file is a mistake in the frame: say
so on the ticket and follow this file.

---

## 0. Principles

1. **One desk, one sheet.** The page is a grey desk. The sidebar sits directly on it, and everything
   you work on goes on one inset white sheet. Inside the sheet, headings, hairlines and space make
   the structure. There are no cards.
2. **Mend reports; the person decides.** Show what happened and the evidence for it, never a
   verdict. No confidence scores, no "safe to merge", no risk dials.
3. **Each colour means one thing.** Cobalt is what you can act on, amber is what needs you, red is
   Failed or destructive. Nothing decorative carries colour.
4. **Only what floats is raised.** The card that holds the agent's question and the composer, menus,
   popovers, dialogs, side sheets and toasts have a shadow. A section of a page never does.
5. **Status is a word.** No spinners and no coloured dots. A session also gets its lump glyph.
6. **Built from the kit.** Every control is a shadcn component from `@mend/ui`, named by its token
   classes, never restyled with raw values.

---

## 1. Colour

Use the Tailwind classes the tokens generate (`bg-canvas`, `text-muted-foreground`,
`border-sheet-border`). Never a hex, `rgb()` or `oklch()` value in app code: `mend/no-raw-colors`
fails it. When a screen needs a colour the kit doesn't have, add a token to `globals.css`, light and
dark, and name its one role here.

### Surfaces

| Token                          | Role                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `canvas`, `sidebar`            | The desk: behind the sheet, under the sidebar and the settings sidebar        |
| `background`                   | The sheet                                                                     |
| `sheet-border`                 | The sheet's 1px edge, and the sidebar's border                                |
| `border`                       | Hairlines between sections, rows and tiles                                    |
| `card`, `popover`              | What floats: the composer card, menus, popovers, dialogs, side sheets, toasts |
| `input`                        | An input's border                                                             |
| `muted`, `secondary`, `accent` | Fills: a user message's bubble, inline code, a secondary button               |
| `field`, `hover`               | A field on the desk, and a row's hover on the desk                            |
| `selection`, `sidebar-accent`  | The open session's row, the selected item in a list                           |
| `selection-inset`              | The selected item inside the sheet                                            |
| `band`                         | A diff hunk header, the band a line comment sits in                           |
| `choice`                       | The picked choice in a question or an approval                                |
| `off`, `off-foreground`        | A control that can't be used yet                                              |
| `scrim`                        | The layer behind dialogs, side sheets, the command palette and phone sheets   |

### Text

| Token              | Role                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `foreground`       | Text                                                                   |
| `foreground-2`     | Secondary text: row titles, labels                                     |
| `muted-foreground` | Meta lines, descriptions, the audience line, every status word but two |
| `faint`            | Placeholders, line numbers and the slashes in a breadcrumb only        |

### Accents: one meaning each

| Token                                            | Means                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `primary`, `ring`, `info`                        | Cobalt: links, focus, the focused tile's active tab, the selected option, the one primary button                       |
| `warning`                                        | Amber: what needs you. The "Waiting on you" heading and count, the word "Waiting on you", and a waiting session's lump |
| `destructive`, `destructive-tint`                | Red: the word "Failed", and destructive actions. The tint is the ground of a destructive button only                   |
| `success`                                        | Green: the icon of a success Banner or Inline alert. A status word is never green                                      |
| `added`, `removed`                               | Diff counts and the marks on changed lines                                                                             |
| `diff-add`, `diff-del`                           | The faint ground of an added or removed line. Never a saturated block                                                  |
| `pr-none`, `pr-open`, `pr-merged`, `pr-conflict` | The lump glyph's colour: the session's pull request                                                                    |
| `underline`                                      | The grey underline of an unfocused tile's active tab                                                                   |
| `claude`, `mark`, `mark-foreground`              | The Claude harness mark, and the organization's mark in the sidebar                                                    |

### Dark

Dark is the `.dark` class on `<html>`, set before first paint. It is the same layout with a second
set of values: a near-black desk and a slightly lighter sheet, so the sheet still reads. Filled
buttons use `primary`; cobalt text uses `info`, which is lighter in dark so it reads on the sheet.
Never give dark a different layout, and never make an edit that only dark needs: fix it with tokens
so both themes get it. Check every screen in both.

---

## 2. Type

- **Instrument Sans** (`font-sans`) for everything a person reads: the interface, prose and
  headings. `font-display` is Instrument Sans too; there is no display face.
- **Geist Mono** (`font-mono`) for machine facts only: ids, SHAs, branches, paths, commands and
  ports.
- Both are self-hosted. An app imports `@mend/ui/styles/fonts.css` once, before `globals.css`.
- Weights: 400 and 500, 600 for headings and group labels, 700 only for the organization's mark.
- Numbers are tabular.

| Use                                      | Class or size           |
| ---------------------------------------- | ----------------------- |
| Page title                               | 22px, 600               |
| Conversation prose, the agent's question | `text-prose`            |
| Body                                     | `text-sm` (14px)        |
| Rows, controls, breadcrumbs              | `text-row`              |
| Meta lines, descriptions                 | `text-meta`             |
| Small labels, mono values                | `text-2xs`, `text-meta` |

A size the kit doesn't name goes into `globals.css` as a named size (and into `lib/utils.ts`, so
`cn` knows it), never as `text-[13px]`: `mend/no-arbitrary-type-or-radius` fails that.

Sentence case everywhere. No uppercase or letter-spaced labels and no mono headings.

---

## 3. Layout and geometry

The sheet's geometry has tokens: `p-sheet-inset` (8px), `w-sidebar` (268px), `h-header` (52px),
`h-tab-strip` (40px), `w-conversation` (704px), `w-settings` (880px) and `w-palette` (512px).

- **The desk and the sheet.** The body is the desk (`bg-canvas`). The sheet sits 8px in from the
  window on its top, right and bottom, with the sidebar on its left: `rounded-xl` (14px), a 1px
  `border-sheet-border` and `shadow-sheet`.
- **The sidebar** sits on the desk and is the only inbox; the desktop home is just the New session
  composer. In order: the organization switcher; search with the New session button beside it;
  Projects and Skills; a filter line ("All projects", "Mine"); the inbox, grouped as Waiting on you,
  To review, Running, Snoozed and Done, each with a count (the first two open, the rest folded);
  Settings and the account at the bottom. A row is a title and one muted line (project, what it is
  waiting on, age). The open session's row has the `selection` fill. Collapsed, the sidebar is a
  48px rail of lump glyphs.
- **The workspace header.** On every session screen the sheet is the workspace. Its 52px header,
  with a hairline under it, holds the sidebar toggle, project / worktree, the branch in mono, the
  layout button, "Open in VS Code" and the workspace's "…" menu. It has no status word: a session's
  status is on its tab.
- **Tiles and tabs.** Under the header the sheet splits into tiles, separated by hairlines with no
  gaps. Each tile has a 40px strip of tabs, a "+" menu, a "…" menu and a maximise button. A session
  tab is the session's lump and title; a view tab is an icon and a name (Change with its +/− counts,
  Preview with its port, Screen, Terminal, Record, Checks, Details). One tile has focus, and its
  active tab has the cobalt underline; another tile's active tab has the `underline` grey. Below
  1024px wide the tiles become one strip of tabs, as on the phone, and the layout button hides. The
  page "Session layouts · Tabs and tiles" draws each state, and
  [ADR 0026](docs/adr/0026-tabs-and-tiles.md) records the rules.
- **The conversation** is a 704px column. The agent's question and the composer form one floating
  card at that width (`rounded-xl`, `shadow-card`): the question, a hairline, then the input and its
  toolbar. In a tile narrower than 760px the column fills the tile with 22 to 28px of side padding,
  and the composer drops the context count first, then the harness name.
- **Settings** has its own sidebar on the desk and an 880px column on the sheet. A 52px breadcrumb
  row comes first, then the page title, one muted audience line ("Only you", "Only this browser",
  "Everyone in Northwind", "Everyone who can open checkout-api", "Operators of this server") and one
  intro sentence. Setting rows are separated by hairlines: label and description on the left, the
  control on the right.
- **Radii.** `rounded-lg` (8px) for buttons, inputs, menus and popovers; `rounded-md` for the rows
  inside them; `rounded-xl` (14px) for the sheet and the composer card; `rounded-palette` (12px) for
  the command palette; `rounded-chip` (7px) for chips in a diff. `rounded-full` only for avatars and
  other true circles.
- **Depth.** Three shadows and nothing else: `shadow-sheet` for the sheet, `shadow-card` for the
  composer card, `shadow-pop` for menus, popovers, the command palette, dialogs, side sheets and
  toasts. Dialogs, side sheets, the palette and phone sheets sit over the `scrim`; menus and toasts
  don't. Nothing lifts on hover.
- **Spacing** uses Tailwind's scale. Whitespace and hairlines group content.
- **Phones.** Every screen works at 390px wide with no sideways scroll. Touch targets are 44px:
  components that have a `touch` size use it there. The phone app (Expo) looks the same as the web.

---

## 4. Status

- A state is one sentence-case word: Running, Waiting on you, Completed, Failed, Stopped and Idle
  (after Stop turn), plus Starting and Stopping. The word is `text-muted-foreground`, except Waiting
  on you in amber and Failed in red.
- The inbox groups are Waiting on you, To review, Running, Snoozed and Done. Older names (Needs you,
  Ready to review, Settled) are wrong in new code. The public glossary changes when the new app
  ships these words.
- A session also has the **lump** glyph, on its tab and on the sidebar rail. Its shape is the
  session's state and its colour is the pull request's (`pr-none`, `pr-open`, `pr-merged`,
  `pr-conflict`); a session waiting on you has an amber lump. Completed is a dome with a check cut
  into it; Idle is the plain dome. The status word never shows the lump.
- No spinners, no coloured dots, no pills. The kit has shadcn's Spinner and Badge; new screens don't
  use them to show a state.
- Never tint a row, a panel or a tile with a status colour. Banner and Inline alert colour only
  their icon.
- Something that runs that isn't a session (a service, a check) uses the same words: a service is
  "Running", never green.

---

## 5. Components: how they must read

Every component on the canvas's Components page has one file in code: a primitive in `packages/ui`,
or a Mend component in `apps/web` built on one. Use the kit's component as it comes. A hand-made
menu, dialog, tooltip, sidebar, tab strip or select loses shadcn's keyboard handling and its open
and close motion.

- **Buttons.** Variants `default` (cobalt, filled), `secondary`, `outline`, `ghost`, `destructive`
  and `link`; sizes 32px, `sm` 28px and `touch` 44px. One `default` per view, on the consequential
  action. A destructive action uses `destructive` and confirms first. A label is a verb and its
  object ("Remove project"), and ends with "…" when it opens a dialog ("Land…", "Stop session…").
- **Menus.** The layout menu, the "+" view menu, the workspace "…", the tile "…" and a session tab's
  right-click menu are all dropdown or context menus (200, 240 or 280px wide, 32px rows). The
  workspace "…" holds workspace actions only: New session in this workspace, Land…, Copy branch
  name, Copy worktree path. A session's own actions (Rename…, Snooze, Mark done, Copy link, Stop
  session…) live on its tab.
- **Dialogs** are 460, 560 or 780px over the scrim. A confirmation is an alert dialog whose title is
  its question ("Stop session?"), with Cancel as the secondary button. On the phone a dialog is a
  full phone sheet.
- **Side sheets** open from the right, inset 8px like the sheet, 440 or 560px wide, for detail you
  read without leaving the page. Never for session details: those are the Details tab.
- **Banner** is a lasting notice in a flat band: under the workspace header when it is about the
  workspace, at the top of a tile's body when it is about one session. Stacked on phones.
- **Inline alert** sits directly under the form field, setup step, dialog or setting it is about. A
  neutral box; the tone colours only the icon.
- **Empty state** names what is missing ("No sessions yet"): a page kind with an icon, title, one
  sentence and one button, or an inline kind with just the sentence.
- **Toast** is a short confirmation at the bottom centre, with an optional Undo in cobalt text.
- **Copy box** shows a key, command or link in mono on a muted fill, with a Copy button. Agent
  logins are connected with `mend connect claude` or `mend connect codex` in a Copy box.
- **Command palette** (⌘K) is 512px wide, 128px from the top, over the scrim.
- **The conversation.** A user message is a `muted` bubble on the right with its sender and time
  under it. An agent's turn starts with one muted line ("Claude Code · turn 3"), then trace rows,
  prose and markers. A marker is a checkpoint divider or one status line. The composer card holds
  the agent's question or an approval above the prompt input, and its send button is the only send
  control: there is no separate "Send answer".
- **The Change view** is a tab: the toolbar (range, Unified or Split, Land…), the file list (a tick
  once viewed, the path in mono, +/− counts) and one Diff per file with tinted lines. Mend's
  description of the change sits above the diffs with "Start tour"; each tour stop says whether the
  session backs it or it is Mend's reading. Review comments sit on the change or between lines.
- **The Details view** is a tab, not a panel: workspace, checks, services and the sessions in this
  workspace, as hairline-divided label and value groups.
- **Setting rows** hold one setting in its one home. There is no inherit control and no "who sets
  their own value" view.
- **Tables** (members, projects) are shadcn tables of hairline rows, with the name column taking the
  rest of the width.

---

## 6. What the system refuses

Each was a live option and was turned down. They hold for every component and page in `apps/web` and
`packages/ui`.

- **No cards for grouping.** The kit has shadcn's Card; a section of a page is a heading, hairlines
  and space, never a bordered or shadowed box.
- **No tinted regions.** Colour marks a word, a count, a line's ground in a diff or a glyph. A
  panel, row or tile tinted green, amber or red reads as a verdict.
- **No more than one thing in amber of equal weight.** Two warnings of the same weight mean neither
  matters.
- **No spinners, coloured dots, pills or chips as containers, and no metric tiles.**
- **No confidence score, risk dashboard or verdict words** (_safe to merge, all good, ready, high
  confidence_). A number invents precision the evidence lacks.
- **No raw values in app code**: no hex colours and no `text-[12.5px]` or `rounded-[9px]`. The lint
  rules fail them.
- **No hand-made overlays** where the kit has the component.
- **No uppercase eyebrows, mono headings, gradients, glow, glassmorphism or hover lift.** Depth is
  the three shadows above.
- **No right-hand details panel and no details toggle.** Details is a tab.
- **No status word in the workspace header.** It belongs to the session's tab.

---

## 7. Product rules that still hold

These come from Evidence Review and do not change with the look.

- **Evidence beside the claim, linked.** A change summary, a tour stop, a review question or a
  provenance line links to the session event, git fact, check or record behind it.
- **The diff stays primary.** Don't surround it with dashboard chrome. Review is fast for someone
  who never opens provenance.
- **Status language is factual.** Write what happened ("Completed", "Failed", "Tests passed at
  checkpoint 5"), never a judgement ("low risk", "trusted change", "agent score").
- **Mend reports; the person decides.** Mend's own reading of a change offers draft comments and
  proposed checks, never a verdict, and says it is Mend's reading.
- **No vanity dashboards.** No token counts, lines generated or productivity scores because the data
  exists. Show information only when it helps someone continue, review or understand the work.
- **Desktop is keyboard-first; the phone is touch-first.** Every desktop action has a keyboard path;
  the phone has large targets and only the actions that matter there.
- **Copy follows the `sealant-design` skill.** A heading names its content; a button is a verb and
  its object; sentence case; plain words. UI strings spell it "organization", as Mend's shipped
  strings do.

---

Every token and component reduces to one rule: **show the person the work and its evidence on one
sheet, in plain words, and let them decide.**
