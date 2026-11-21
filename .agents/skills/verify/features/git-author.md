# Git author

The git author is the name and email that commits made in a person's workspaces carry. Until the
person sets one, it is the name and email they registered with. They change it on Settings → Git
author or with `mend git-author`. Mend writes it as system git config in a shared-home workspace. In
a per-person workspace, Mend writes `~/.mend/git-author` and includes it at the top of
`~/.config/git/config`. The person's own `user` settings in dotfiles or the repository's config
still decide.

## Sub-features

- `git-author-show` prints the current author and where it comes from: the person's setting or their
  account.
- `git-author-set-web` saves a name and email from Settings.
- `git-author-set-cli` saves one with `mend git-author "<name>" <email>`.
- `git-author-refused` refuses an empty name, a name with `<`, `>` or a line break, or an email that
  is not an address, before anything is sent.
- `git-author-clear` returns to the account's name and email (`Use my account's`, `--clear`).
- `git-author-session` shows the author in a newly launched workspace's git config.

## How to get to it (user POV)

- Web: `Settings` in the primary navigation opens `/settings`; the `Git author` panel.
- CLI: `mend git-author`, `mend git-author "<name>" <email>`, `mend git-author --clear`.
- TUI, desktop, mobile, VS Code, Slack: no git author surface.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser is signed in, and `<project>` is adopted.
- The account has no git author setting: `mend git-author` ends `· your account's name and email`.
  If it ends `· your setting`, run `mend git-author --clear` first.
- No dotfiles repository or snapshot carries a `.gitconfig` with a `user` section (`mend dotfiles`),
  and `<repo-url>`'s own config sets no `user`.

- **Show.** Run `mend git-author`. Stdout is
  `<account name> <<account email>> · your account's name and email`. Exit code `0`.
- **Web panel.** Run `await page.goto("<web>/settings/git-access")`. Under the heading `Git author`,
  the textbox `Name` holds the account name and the textbox `Email` the account email, each field
  marked `from your account`. There is no `Use my account's name and email` button and no save bar.
- **Web refusal.** Run `await page.getByRole("textbox", { name: "Email" }).fill("not-an-email")`. A
  save bar appears whose summary reads `the email is not an address like you@example.com`, and
  `Save author` is disabled.
- **Web save.** Run `await page.getByRole("textbox", { name: "Name" }).fill("Verify Web")` and
  `await page.getByRole("textbox", { name: "Email" }).fill("verify-web@example.com")`, then
  `await page.getByRole("button", { name: "Save author" }).click()`. The page then says
  `Saved · applies to sessions launched from now on` and the button
  `Use my account's name and email` appears.
- **Second view.** Run `mend git-author`. Stdout is
  `Verify Web <verify-web@example.com> · your setting`.
- **CLI set.** Run `mend git-author "Verify Cli" verify-cli@example.com`. Stdout is
  `✓ git author · Verify Cli <verify-cli@example.com> · your setting`, then
  `  sessions launched from now on commit as this, unless their dotfiles say otherwise`. Exit code
  `0`. Reload the web page: the textboxes `Name` and `Email` hold `Verify Cli` and
  `verify-cli@example.com`, no `from your account` mark, and the button
  `Use my account's name and email`
  (`page.getByRole("button", { name: "Use my account's name and email" })`) is shown. The web has no
  `your setting` words.
- **CLI refusal.** Run `mend git-author "Verify Cli" not-an-email`. Stderr is
  `mend: git author not saved · the email is not an address like you@example.com`. Exit code `1`.
  Run `mend git-author OnlyName`. Stderr is `mend: usage: mend git-author [<name> <email>]` followed
  by `       mend git-author --clear`. Exit code `1`. `mend git-author` still shows `Verify Cli`.
- **Session commits as it.** Run
  `mend run --project <project> -- sh -c 'git config user.name > AUTHOR.md && git config user.email >> AUTHOR.md'`.
  Exit code `0`. The change (see [Review a change](./review-change.md)) holds `AUTHOR.md` with
  `Verify Cli` and `verify-cli@example.com`.
- **Web clear.** Run
  `await page.getByRole("button", { name: "Use my account's name and email" }).click()`. It reads
  `Saving…`, then the textboxes return to the account's name and email marked `from your account`,
  and the button disappears.
- **CLI clear.** Set it again with the CLI, then run `mend git-author --clear`. Stdout is
  `✓ git author · <account name> <<account email>> · your account's name and email`.
- **Proof.** Keep the ARIA snapshot and screenshot of the Git author panel before the save, after
  the save and after the clear; every `mend git-author` transcript with exit codes; and the
  `AUTHOR.md` diff from the session.

## Gotchas

- `Use my account's name and email` uses a straight apostrophe in its accessible name. It is
  rendered only while the author comes from a setting.
- On the box (17 Nov) the panel was read with a setting saved: `Name`, `Email` and
  `Use my account's name and email`. The `from your account` marks, the save bar (`Save author`, its
  summary, `Saved · applies to sessions launched from now on`) and the clear's `Saving…` were the
  old app's words, not confirmed by a capture. The web app's author rows are `AuthorRows` in
  `apps/web/src/components/settings/agent-logins-page.tsx` (Settings → Agent logins and Git): take
  their words from there.
- The web form checks only once something changed: an unchanged invalid value shows no error.
- `mend git-author` takes exactly two words, name then email. Quote a name with spaces.
- A `user` section in the person's dotfiles or in the repository's config wins over the setting, by
  design. Clear dotfiles first, or the `AUTHOR.md` step shows the dotfiles' author.
- Shared-home workspaces receive the author at launch. In a per-person home Mend rewrites the author
  at every identity pickup, so a changed setting applies at the next pickup, including in an
  existing workspace.
- When Mend cannot write the author into a workspace, it logs a warning on the server only; the
  session page says nothing. The `AUTHOR.md` step is the observable proof.
- In a per-person workspace `~/.config/git/config` includes `~/.mend/git-author` at its top. Later
  `user` settings in that config and in `~/.gitconfig` take precedence. `git config user.name` reads
  the resulting author.
