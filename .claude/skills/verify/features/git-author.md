# Git author

The git author is the name and email that commits made in a person's workspaces carry. Until the
person sets one, it is the name and email they registered with. They change it on Settings → Git
author or with `mend git-author`, and sessions launched afterwards commit as the new author. Mend
writes it as system git config before the agent starts, so a `user` section in the person's
dotfiles `.gitconfig`, or in the repository's own config, still decides.

## Sub-features

- `git-author-show` prints the current author and where it comes from: the person's setting or
  their account.
- `git-author-set-web` saves a name and email from Settings.
- `git-author-set-cli` saves one with `mend git-author "<name>" <email>`.
- `git-author-refused` refuses an empty name, a name with `<`, `>` or a line break, or an email
  that is not an address, before anything is sent.
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
- **Web panel.** Run `await page.goto("<web>/settings")`. Under the heading `Git author`, the
  textbox `Name` holds the account name, the textbox `Email` the account email, and the line reads
  `your account's name and email · not set`. `Save author` is disabled; there is no
  `Use my account's` button.
- **Web refusal.** Run
  `await page.getByRole("textbox", { name: "Email" }).fill("not-an-email")`. The line
  `the email is not an address like you@example.com` appears and `Save author` stays disabled.
- **Web save.** Run `await page.getByRole("textbox", { name: "Name" }).fill("Verify Web")` and
  `await page.getByRole("textbox", { name: "Email" }).fill("verify-web@example.com")`, then
  `await page.getByRole("button", { name: "Save author" }).click()`. The button reads `Saving…`,
  then the line reads `saved` and the button `Use my account's` appears.
- **Second view.** Run `mend git-author`. Stdout is
  `Verify Web <verify-web@example.com> · your setting`.
- **CLI set.** Run `mend git-author "Verify Cli" verify-cli@example.com`. Stdout is
  `✓ git author · Verify Cli <verify-cli@example.com> · your setting`, then
  `  sessions launched from now on commit as this, unless their dotfiles say otherwise`. Exit
  code `0`. Reload the web page: the textboxes hold `Verify Cli` and `verify-cli@example.com` and
  the line reads `your setting`.
- **CLI refusal.** Run `mend git-author "Verify Cli" not-an-email`. Stderr is
  `mend: git author not saved · the email is not an address like you@example.com`. Exit code `1`.
  Run `mend git-author OnlyName`. Stderr is `mend: usage: mend git-author [<name> <email>]` followed
  by `       mend git-author --clear`. Exit code `1`. `mend git-author` still shows `Verify Cli`.
- **Session commits as it.** Run
  `mend run --project <project> -- sh -c 'git config user.name > AUTHOR.md && git config user.email >> AUTHOR.md'`.
  Exit code `0`. The change (see [Review a change](./review-change.md)) holds `AUTHOR.md` with
  `Verify Cli` and `verify-cli@example.com`.
- **Web clear.** Run `await page.getByRole("button", { name: "Use my account's" }).click()`. The
  textboxes return to the account's name and email, the line reads `saved`, and
  `Use my account's` disappears. After a reload the line reads
  `your account's name and email · not set`.
- **CLI clear.** Set it again with the CLI, then run `mend git-author --clear`. Stdout is
  `✓ git author · <account name> <<account email>> · your account's name and email`.
- **Proof.** Keep the ARIA snapshot and screenshot of the Git author panel before the save, after
  the save and after the clear; every `mend git-author` transcript with exit codes; and the
  `AUTHOR.md` diff from the session.

## Gotchas

- `Use my account's` uses a straight apostrophe in its accessible name. It is rendered only while
  the author comes from a setting.
- The panel's status line (`saved`, `your setting`, `your account's name and email · not set`) and
  its red error line are plain text, not `role="status"` or `role="alert"`.
- The web form checks only once something changed: an unchanged invalid value shows no error.
- `mend git-author` takes exactly two words, name then email. Quote a name with spaces.
- A `user` section in the person's dotfiles or in the repository's config wins over the setting, by
  design. Clear dotfiles first, or the `AUTHOR.md` step shows the dotfiles' author.
- The change applies to sessions launched after it. A running session keeps the author it started
  with.
- When Mend cannot write the author into a workspace, it logs a warning on the server only; the
  session page says nothing. The `AUTHOR.md` step is the observable proof.
- In a per-person workspace the author goes into the person's own `~/.config/git/config` instead of
  system config. `git config user.name` reads it the same way.
