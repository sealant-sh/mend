# Sheet: Mend's design language

Version 4.0 (November 2026). Applies to the web app. The marketing site and the desktop app still
use the older Evidence Review look (`packages/ui/src/styles/globals.css`) until they move.

Sheet replaces Evidence Review in the web app. It keeps that look's rules on colour and on status
wording, and drops its warm paper, Space Grotesk, lifted cards and cobalt shadows. The designs are
on the Doop canvas "Mend": the style guide `mend-system`, the reference frames on the page "Sheet,
Graphite, Night", and every screen on the page "Flows · Sheet + Lump".

The web app is moving to Sheet in slices. Colours, type and the desk come first. The inset sheet,
the sidebar grouped by state, the question-and-composer card, the status glyph and restyled
components follow. A small fix to a screen that hasn't moved yet matches its neighbours.

---

## 0. Principles

1. **One desk, one sheet.** The sidebar sits on a grey desk. Everything you work on sits on a white
   sheet. That is the only container; inside it, structure comes from headings, hairlines and space.
2. **The tool reports, it does not judge.** Show what happened, never a verdict. No confidence
   scores, no "safe to merge", no risk dials. The person decides.
3. **Colour is earned.** Cobalt for what you can act on. Amber once per screen for what needs you.
   Red for failure. Nothing decorative carries colour.
4. **Only floating things are raised.** The composer card, menus, popovers and dialogs have a border
   and a shadow. A section of a page never does.
5. **Words over marks.** Status is a word. No spinners and no coloured dots in new UI.

---

## 1. Colour

All values are CSS custom properties. The web app sets them in `apps/web/src/styles.css`, under the
token names `packages/ui/src/styles/globals.css` defines. **Use tokens, never raw hexes**, in app
code (`bg-background`, `bg-canvas`, `text-muted-foreground`, `border-rule`, `text-info`).

| Token             | Light     | Dark      | Role                                               |
| ----------------- | --------- | --------- | -------------------------------------------------- |
| `--sw-canvas`     | `#eceef1` | `#0e1013` | The desk: behind the sheet, under the sidebar      |
| `--sw-bg`         | `#ffffff` | `#181b20` | The sheet                                          |
| `--sw-panel`      | `#ffffff` | `#1e2127` | Floating cards, menus, dialogs                     |
| `--sw-sunken`     | `#f3f4f6` | `#23272e` | Fills: a message bubble, inline code, hover        |
| `--sw-wash`       | `#eef2fe` | `#232a40` | Cobalt tint: the selected option                   |
| `--sw-ink`        | `#111827` | `#e8eaee` | Text                                               |
| `--sw-ink-2`      | `#374151` | `#c6cbd3` | Secondary text: row titles, labels                 |
| `--sw-muted`      | `#6b7280` | `#959cab` | Muted text: meta lines, descriptions, status words |
| `--sw-faint`      | `#9ca3af` | `#737b88` | Placeholders and separators only                   |
| `--sw-rule`       | `#d9dce2` | `#30353d` | Input borders, the sheet's edge                    |
| `--sw-soft-rule`  | `#e7e9ed` | `#262a31` | Hairlines between sections and rows                |
| `--sw-faint-rule` | `#eef0f3` | `#212429` | Innermost row dividers                             |

### Accents: one meaning each

| Colour | Token                                         | Means                                 |
| ------ | --------------------------------------------- | ------------------------------------- |
| Cobalt | `--sw-accent` `#2f5bea` (dark text `#7c98ff`) | Links, focus, the active tab, primary |
| Amber  | `--sw-amber-text` `#a35407` (dark `#f0b45a`)  | Needs you. Once per screen.           |
| Red    | `--sw-red-text` `#c81e1e` (dark `#ff7a70`)    | Failed, and destructive actions       |
| Green  | `--sw-green` `#15803d` (dark `#5ccb8b`)       | Added lines and counts in a diff      |

In dark mode a filled primary button is a deeper cobalt (`#4566ee`) so its white text reads. Cobalt
is also `--primary` and `--ring`; red is also `--destructive`.

### Diffs

Tinted lines, never saturated blocks: added `--sw-add-bg` with a `--sw-add-edge` mark, removed
`--sw-del-bg` with `--sw-del-edge`. Context lines are transparent.

### Dark

Dark is the same design with a second palette: a near-black desk and a slightly lighter sheet, so
the sheet still reads. Never give dark a different layout. Check every screen in both.

---

## 2. Type

- **Instrument Sans** (`font-sans`) for everything a person reads: interface, prose, headings.
  Weights 400, 500 and 600. There is no display face; `font-display` is Instrument Sans too.
- **Geist Mono** (`font-mono`) for machine facts: ids, SHAs, branches, paths, commands, ports.
- Numbers are tabular.

| Use                        | Size and weight     |
| -------------------------- | ------------------- |
| Page title                 | 22px · 600          |
| Conversation prose         | 15px · 400 · 1.6    |
| Body, the agent's question | 14–15px · 400–600   |
| Rows, controls             | 13–13.5px · 400–500 |
| Meta lines, descriptions   | 12.5px · 400        |
| Mono values                | 12–12.5px           |

Sentence case everywhere. No uppercase or letter-spaced labels as headings. The old `.ev-eyebrow` is
on its way out; don't add new ones.

---

## 3. Layout and geometry

- **The desk and the sheet.** On a wide screen the sidebar sits on the desk (`bg-canvas`). The page
  sits on the sheet (`bg-background`), inset 8px from the window with a 14px radius, a 1px
  `--sw-rule` border and `shadow-sm`. On a phone the sheet is the whole screen.
- **Sidebar.** 272px. The org switcher, search and new session, Projects and Skills, a filter line,
  then the inbox grouped by state: Needs you and Ready to review open; Running, Snoozed and Settled
  folded with counts. Each row is a title and one muted line. The open session has a neutral
  selected fill.
- **Session.** A 52px header (breadcrumb, status word, actions), tabs under a hairline, a 704px
  conversation column and a 320px right panel divided by hairlines. The agent's question and the
  composer are one floating card at the column's width: the question, a hairline, then the input.
- **Content pages** (Projects, Skills, Settings) stop at `max-w-page` and are centred. Settings rows
  are hairline-separated: label and description on the left, control on the right.
- **Radius.** 8px for buttons and inputs, 14px for the sheet and floating cards, `rounded-full` only
  for avatars.
- **Depth.** `shadow-sm` for the sheet; `shadow-md` for the composer card; `shadow-lg` or
  `shadow-overlay` for menus and dialogs. Nothing lifts on hover.

---

## 4. Status

- A session's state is a sentence-case word in `text-muted-foreground`: Running, Waiting on you,
  Completed, Failed, Stopped. Use the same words for anything else that runs.
- The only coloured status words: "Failed" in red, and the one amber "Needs you" or "Waiting on you"
  per screen.
- Beside a session, Sheet adds a small glyph (the "lump"): its shape is the session's state, its
  colour the pull request (none, open, merged, conflict). It is drawn in the Doop guide
  `sheet-lump`. Until it ships, existing screens keep their dots; don't add new ones.
- No spinners. Never tint a row or a panel with a status colour.

---

## 5. Components

Components are shadcn (`base-nova`, Base UI primitives), themed by the tokens above.

- **Buttons.** Sentence case, 8px radius. One filled primary per view; the rest outline or ghost. A
  label that opens a dialog ends with "…".
- **Lists.** Flat rows divided by hairlines, never a card per row. Hover is a `bg-secondary` fill;
  the selected row a neutral fill.
- **Sections.** A heading, an optional muted description, then hairline-divided rows. Never a
  bordered, shadowed box around a section.
- **Floating cards.** The composer card, menus, popovers and dialogs: `bg-popover`, a 1px border,
  14px (cards) or 10px (menus) radius, a shadow from §3.
- **Diff.** Geist Mono, line numbers in `--sw-faint`, tinted added and removed lines, the file list
  beside it.
- **Callouts.** Text with a 2px coloured left edge: amber for an open question, red for a failure.

---

## 6. What the system refuses

- **No cards for grouping.** A section of a page is never a bordered, shadowed box.
- **No panel tinted green, amber or red.** Colour marks a word or a value; it never floods a region.
- **No more than one amber element** per screen.
- **No spinners, no coloured status dots, no glowing badges, no pills as containers.**
- **No confidence score or risk dashboard.** A number invents precision the record lacks.
- **No uppercase prose, no heavy rules, no gradients, no glass, no hover lifts.**
- **No verdicts in copy:** _strong proof, high confidence, all checks passed, safe to merge_. Write
  what happened, plainly.

---

## 7. Product rules for Mend

- **The record beside the claim, linked.** A change summary, review question or provenance statement
  links to the session event, git fact, context item or check behind it.
- **The diff stays primary.** Don't surround it with dashboard chrome.
- **Provenance is progressive disclosure.** The default view says what changed; a panel answers why,
  when and from which session.
- **Status words say what happened:** running, waiting, completed, failed, not run, attribution
  unknown. Never _low risk_, _agent score_ or _trusted change_.
- **Desktop is keyboard-first; mobile is touch-first.** Full keyboard navigation for review on a
  desktop; readable unified diffs, 44px targets and only the actions that matter on a phone.
- **No vanity dashboards.** No token counts, lines generated or productivity scores just because the
  data exists.
