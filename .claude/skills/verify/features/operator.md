# Operator commands

The operator is an instance role, held by the first account registered on an empty instance. It
administers the machine and has no default read access to organization content. Its acts on
organizations run from the terminal, under `mend operator`: list organizations with their member and
owner counts, create one (multi tenancy only), rename one, print a one-time owner invitation, make an
existing member an owner, and print a one-time password reset link for any account. Every one of
them refuses an account without the role, and each act on an organization lands in that
organization's audit log, where its owners read it.

## Sub-features

- `org-list` prints one line per organization with member and owner counts; an ownerless one says
  `no owner`.
- `org-create` creates an empty organization; refused in `MEND_TENANCY=single`.
- `org-rename` renames an organization.
- `org-invite-owner` prints a one-time link that makes whoever opens it an owner.
- `grant-owner` makes an existing member an owner.
- `reset-link` prints a one-time password reset link for an account; its page is `/reset/<token>`.
- `operator-only` refuses every `mend operator` command for an account without the role.
- `operator-audit` records each act in the organization's audit log.
- `instance-defaults` shows the operator, and only the operator, the `instance · operator`
  defaults on `/settings`.

## How to get to it (user POV)

- CLI: `mend operator org list`, `mend operator org create <name>`,
  `mend operator org rename <org> <name>`, `mend operator org invite-owner <org> [--email <address>]`,
  `mend operator grant-owner <org> <email>`, `mend operator reset-link <email>`.
- CLI: `mend operator gate` and `mend operator exposure` are mapped in [exposure.md](./exposure.md).
- Web: the links these commands print open `/join/<token>` ([organization.md](./organization.md))
  and `/reset/<token>` ([sign-in.md](./sign-in.md)). The organization's owners read the operator's
  acts in Settings → `Audit log`.
- Web: on `/settings`, the eyebrow `instance · operator` and the instance's `Workspace environment`,
  `Sessions`, `Review automation` and `Landing` panels render only for the operator (mapped in
  [project-settings.md](./project-settings.md)).
- Desktop, mobile, VS Code, TUI and Slack have no operator controls.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` in `MEND_TENANCY=single`. The default CLI is signed in as the first
  account, `<owner>`, which holds the operator role.
- A second account `<member>` belongs to the organization, with its CLI at
  `XDG_CONFIG_HOME=/tmp/verify-member` (built in [organization.md](./organization.md)). Its email is
  `<member-email>`.
- `<org>` is the organization's name, read from the first line of `mend members`.

- **List.** Run `mend operator org list`. One line: `<org>  2 members · 1 owner`. Exit code `0`.
- **Refuse a non-operator.** Run `XDG_CONFIG_HOME=/tmp/verify-member mend operator org list`. Exit
  code `1`, stderr `mend: this account is not the operator of this Mend`. The same for
  `… mend operator gate`.
- **Refuse create in single.** Run `mend operator org create verify-second`. Exit code `1`, stderr
  `mend: This Mend runs one organization (MEND_TENANCY=single). Rename it instead.`
- **Rename.** Run `mend operator org rename <org> <org>-renamed`. Stdout
  `✓ renamed <org> to <org>-renamed`. `mend members` now starts `<org>-renamed · 2 members`. Rename
  it back with `mend operator org rename <org>-renamed <org>`.
- **Unknown organization.** Run `mend operator org rename no-such-org x`. Exit code `1`, stderr
  `mend: no organization named "no-such-org"`.
- **Owner invitation.** Run
  `mend operator org invite-owner <org> --email verify-owner@example.invalid`. Stdout line 1 is
  `<web>/join/<token>`, line 2 is
  `owner of <org> · for verify-owner@example.invalid · works once · expires <YYYY-MM-DD>`. Opened
  in a signed-out browser, the join page's line reads `as owner · expires <day>`. Revoke it from
  Settings → Invitations afterwards.
- **Grant owner.** Run `mend operator grant-owner <org> <member-email>`. Stdout
  `✓ <member-email> is an owner of <org>`. `mend members` shows `<member>` as `owner`.
- **Grant to a stranger.** Run `mend operator grant-owner <org> nobody@example.invalid`. Exit code
  `1`, stderr `mend: No member of <org> has that email. Invite an owner instead.`
- **Reset link.** Run `mend operator reset-link <member-email>`. Stdout line 1 is
  `<web>/reset/<token>`, line 2 is
  `password reset for <member-email> · works once · expires <YYYY-MM-DD>`. Opening it in a
  signed-out browser shows the heading `Set a new password`; setting one there is mapped in
  [sign-in.md](./sign-in.md).
- **Reset a stranger.** Run `mend operator reset-link nobody@example.invalid`. Exit code `1`, stderr
  `mend: No active account in an organization has that email.`
- **Owners read what the operator did.** As `<owner>` in the browser, go to `<web>/settings`. The
  `Audit log` lists `<owner> issued a password reset link for <member>, as the operator`,
  `<owner> made <member> an owner, as the operator`, `<owner> created an invitation link for owner`
  and `<owner> renamed the organization to <org>`.
- **Instance defaults are the operator's.** On `<web>/settings` as `<owner>`, the text
  `instance · operator` is visible. As `<member>` (browser `memberPage`), it is not.
- **Restore.** Make `<member>` a member again from Settings → Members: both owner rows now carry a
  `Make member` button, so scope it to `<member>`'s row by its email (see the Gotchas of
  [organization.md](./organization.md)).
- **Proof.** Keep every `mend operator` transcript with stdout, stderr and exit code, the
  `mend members` transcripts before and after the grant, and an `ariaSnapshot()` of the `Audit log`
  section.

## Gotchas

- Organization names are matched exactly; quote a name with spaces. Only the value right after
  `--email` is skipped when the command reads its words, so put flags after the positional
  arguments.
- An unknown subcommand prints `mend: unknown operator command "<word>" · mend help operator org list`
  (or `unknown operator org command`), exit code `1`.
- `org create` is accepted only with `MEND_TENANCY=multi`, which refuses to start until the multi mode gate
  passes ([exposure.md](./exposure.md)). In a single-tenancy run only its refusal is drivable.
- `grant-owner` on someone who is already an owner prints the same `✓` line and changes nothing.
- The links print once. Nothing lists them later; a lost link means a new one.
- An operator reads no organization content through these commands: `org list` prints counts only.
  There is no web page for operator acts by design (ADR 0003, "Operator").
- The operator role is the first account's. A run that signs in as any other account sees every
  `mend operator` command refused.
- Owners reset only members' passwords from Settings. An owner's or the operator's own password is
  reset only with `mend operator reset-link`. Settings shows no `Reset password` on an owner's row,
  and the API refuses one with
  `Owners and the operator reset their passwords through the operator of this Mend.`
