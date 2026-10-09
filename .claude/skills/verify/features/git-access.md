# Git access

Clone, fetch and push run on the Mend server; workspaces never receive an SSH key. Each person
chooses how the server reaches their remotes: `mend-key`, an ed25519 key of their own generated
and held on the server, whose public half they add to their git account (or to one repository as a
deploy key); or `bridge`, which signs through the ssh-agent on their own machine while a `mend`
command runs there, so a hardware key never leaves the desk. New projects adopt with that choice; a
project's Setup page overrides it with `mend key`, `bridge` or `ambient` (the server's own git and
ssh setup), and `mend adopt --auth` overrides it for one adoption. Mend reports what it observed:
the key to add, and whether a signer is connected.

## Sub-features

- `mode-choice` sets the person's default mode: Settings → Git access, `/welcome`, or
  `mend keys mode`.
- `mend-key` creates and shows the person's Mend key (`Create my Mend key`, `mend keys init`,
  `mend keys show`).
- `key-card` shows the public key with `Copy` and where to add it, naming the repository's
  deploy-key page on a GitHub project.
- `bridge-share` relays the machine's ssh-agent (`mend keys share`, or any attaching `mend`
  command while the mode is `bridge`) and shows `signer connected · <machine>`.
- `project-override` sets one project's mode on its Setup page (`mend key`, `bridge`, `ambient`).
- `adopt-auth` picks the mode for one adoption (`mend adopt --auth`).

## How to get to it (user POV)

- Web: `/welcome`, step two of first contact (heading `Git access`), right after the first
  account; it creates the Mend key before first paint when the mode is `mend-key`.
- Web: Settings (`/settings#git-access`), the heading `Git access`. The Now page's first-run row
  `Git access` links `Settings → Git access` and shows the key card.
- Web: a project's Setup tab (`/projects/<id>/setup`, section `#git`), the heading `Git access`.
- Web: the adopt panel's access choice on `/projects` (see [Adopt a project](./adopt-project.md)).
- CLI: `mend keys init`, `mend keys show`, `mend keys mode [mend-key|bridge]`, `mend keys share`,
  and `mend adopt … --auth ambient|mend-key|bridge`.
- Other surfaces have no git access controls.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI are signed in as the same account, and
  `<project>` is adopted with `ambient` access.
- For `bridge`, the run's machine has an ssh-agent with a key loaded (`SSH_AUTH_SOCK` set).
- The private adoption steps need a disposable git account or repository the run may add a key
  to and its SSH remote URL, written `<private-ssh-repo-url>` (`git@github.com:<owner>/<repo>.git`
  or `ssh://git@<host>/<owner>/<repo>.git`). The Mend key and the bridge sign SSH transport only;
  an HTTPS clone does not exercise either signer. Without that fixture, report the steps unreachable.
- Note the account's mode (`mend keys mode`) and `<project>`'s mode, and restore both at the end.

- **Show the key.** Run `mend keys show`. With no key it prints
  `no Mend key yet — mend keys init generates one (ed25519, stays on the server host)`.
- **Create it.** Run `mend keys init`. Stdout shows
  `✓ Mend key ready (private half stays on the server host)`, the public key (`ssh-ed25519 …`), its
  fingerprint, and
  `  add this to your git account's SSH keys (GitHub: settings → SSH keys) so`. Exit `0`. Run it
  again: the same public key prints. `mend keys show` prints it too.
- **Settings view.** Run `await page.goto("<web>/settings#git-access")`. The heading `Git access`
  is visible with two buttons, `page.getByRole("button", { name: /^A Mend key on your git account/ })`
  and `page.getByRole("button", { name: /^Your machine's key/ })`. In `mend-key` mode the key card
  shows a button whose name is the public key, a `Copy` button, and the text
  `Add it to your git account's SSH keys (GitHub) …`.
- **Switch to bridge on the web.** Choose `Your machine's key`. The key card is replaced by
  `no signer connected` and the line that starts `Any attaching mend command and the dashboard
  share your machine's agent`. Run `mend keys mode`: stdout reads
  `bridge — this machine's ssh-agent signs; only while a mend command runs here` and
  `  no signer connected — mend shares the agent whenever it runs (or: mend keys share)`.
- **Share the agent.** Run `mend keys share` in its own PTY. It prints
  `● sharing this machine's ssh-agent with <web>` and
  `  agent: <socket> · signature requests print here · Ctrl-C stops sharing`. Within five seconds
  the Settings section reads `signer connected · <hostname>`, and `mend keys mode` prints
  `● signer connected · <hostname>`. Send `Ctrl-C`; the page returns to `no signer connected`.
- **Switch back from the CLI.** Run `mend keys mode mend-key`. Stdout reads
  `✓ git access · mend-key`, `mend-key — your Mend key on the server signs; works whenever the server is up`
  and the key. Exit `0`. Reload Settings: the key card is back. Run `mend keys mode nonsense`:
  stderr reads `mend: keys mode takes mend-key or bridge, not "nonsense"`, exit `1`.
- **Project override.** Open `<project>`'s page from `/projects`, choose the link `Setup`, or run
  `await page.goto("<web>/projects/<id>/setup#git")` with `<id>` from the project page's URL. The heading
  `Git access` (`page.getByRole("heading", { name: "Git access" })`) is visible with the buttons
  `mend key`, `bridge` and `ambient`. Run
  `await page.getByRole("button", { name: "mend key" }).click()`. The key card appears; on a
  GitHub origin its text links `<owner>/<repo>` for the deploy-key page. Choose `bridge`: the card
  reads `no signer connected` and the hint naming `mend keys share`. Choose `ambient`: both go.
- **Adopt with the key.** After adding the public key to the disposable git account, run
  `mend adopt <private-ssh-repo-url> --name <project>-key --auth mend-key`. Stdout shows
  `✓ adopted · <project>-key · <store path>` and
  `  git auth mend key (your Mend key signed this clone)`. Exit `0`.
- **Adopt over the bridge.** Set `mend keys mode bridge`, keep `mend keys share` running in its
  own PTY, and run `mend adopt <private-ssh-repo-url> --name <project>-bridge --auth bridge`. Stdout
  shows ``  git auth bridge (signed through the connected `mend keys share`)``, and the share's
  terminal prints `✎ signature requested by mend (…)` then `✓ signed (<n>s)`.
- **Refused mode.** Run `mend adopt <repo-url> --auth nope`. Stderr reads
  `mend: --auth takes "ambient", "mend-key", or "bridge", not "nope"`, exit `1`.
- **Second view.** Run `mend projects`; the adopted projects are listed. Reload the Setup page of
  `<project>-key`: `mend key` is the chosen mode and the key card shows the same public key.
- **Proof.** Save `await page.locator("body").ariaSnapshot()` and a screenshot of Settings → Git
  access in each mode, and of the project's Setup `Git access` card. Keep the `mend keys`,
  `mend keys share` and `mend adopt` transcripts with exit codes. Restore the noted modes.

## Gotchas

- Neither the Settings choice buttons nor the Setup buttons (`mend key`, `bridge`, `ambient`)
  report which one is chosen: no `aria-pressed`, no `aria-checked`, only styling. Read the mode from
  what the section shows (the key card or the signer line) or from `mend keys mode`. That is a
  finding.
- The Settings choice buttons are named by their title and description together
  (`A Mend key on your git account Your own key, created on …`). Match them with an anchored
  regular expression.
- The key card's main button is named by the whole public key; its `title` (`Copy public key`) is
  not its name. The small `Copy` beside it is transparent until hovered but still in the tree.
- Visiting `/welcome` creates the Mend key as a side effect when the mode is `mend-key`, so a fresh
  account that walked first contact already has one; `mend keys init` then prints the same key.
- `mend adopt` does not share the agent itself. A `--auth bridge` adoption needs `mend keys share`
  running (or another attaching `mend` command); without a signer, git for bridge projects does not
  wait and fails with a message that says so.
- The server takes one signer per account; a newer `mend keys share` replaces the older one.
- `mend keys` with no verb prints the key like `mend keys show`; `help.ts` documents only the verbs.
- `mend doctor`'s help page says it reports "the git key", but `mend doctor` prints no git key
  line (product gap, `apps/cli/src/help.ts` against `apps/cli/src/doctor.ts`).
- `ambient` uses the server process's own git and ssh setup; in the Docker deployment that reaches
  only public remotes. Adopted with `ambient`, a private repository fails with the remote's own
  words.
- Changing a mode applies to the next git operation; running workspaces are not rebuilt.
