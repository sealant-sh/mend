---
title: Skills
description:
  Keep skill bundles on the Mend server, for yourself or for a project, and have them delivered to
  Claude Code and Codex in every session workspace.
sidebar:
  order: 8
---

A skill is a named bundle of instruction files: a `SKILL.md` at the top, plus any support files it
refers to. Claude Code and Codex find skills in their own skills directories and load one when it
applies. Mend keeps skills on the server and writes them into each session's workspace, so an agent
there has the same skills as the one on your machine.

Mend keeps two libraries:

- **Your library** belongs to your account. Like [dotfiles](/guides/dotfiles/), it follows you into
  every project. The web app calls these your global skills.
- **A project's library** belongs to the project and applies to every session in it, whoever starts
  the session.

## Push your local skills

The shared convention keeps skills under `~/.agents/skills/<name>/SKILL.md`. Push that directory to
your library:

```sh
mend skills push
```

Every subdirectory that holds a `SKILL.md` becomes one skill, named after the directory in lower
case. The description comes from a single-line `description:` in the `SKILL.md` frontmatter. The
push creates new skills, replaces same-named ones, and leaves unchanged ones alone, then reports the
counts:

```text
pushed 12 skills from /home/you/.agents/skills to your library · 2 new · 1 updated · 9 unchanged
sessions receive them from the next launch
```

Options:

```sh
mend skills push --dir ./skills          # scan another directory
mend skills push --prune                 # also remove skills the directory no longer has
mend skills push --project               # push into the current directory's project library
mend skills push --project api           # push into the library of the project named api
```

The scan skips hidden directories, `.git`, `node_modules` and `__pycache__`, and prints a line for
each thing it leaves out: a directory without a `SKILL.md`, a binary file, a file over 512 KB, or a
bundle with more than 64 files.

List a library with `mend skills`, or `mend skills --project [p]` for a project's.

## Manage skills in the web app

**Skills** in the web app's navigation opens your library. **New skill** asks for a name, a
description and the `SKILL.md` contents. Opening a skill lets you edit its description and files,
add a file by its path in the bundle (for example `references/notes.md`), and remove the skill.

A project's skills live on its **Setup** page, in the **Skills** section. The section lists your
global skills and whether each one is **Inherited**, **Overridden here** by a project skill with the
same name, or **Off**, then the project's own skills with the same controls as your library.

**Use global skills** on that section decides whether sessions in the project receive the session
owner's library. It is on by default. Turned off, sessions in the project receive only the project's
skills.

Anyone who can see a project can read its skills. Changing them, or the **Use global skills**
switch, takes an owner or the member who created the project.

## What a session receives

When Mend creates a session's workspace, it resolves the skills for that session:

1. The session owner's library, when the project uses global skills.
2. The project's library. A project skill replaces a global skill with the same name.

Mend writes the result into the workspace's harness home, once for each harness that reads skills:

| Harness     | Directory in the workspace |
| ----------- | -------------------------- |
| Claude Code | `~/.claude/skills/<name>/` |
| Codex       | `~/.codex/skills/<name>/`  |

In the workspace, `~/.claude` and `~/.codex` link into the harness home at
`/workspace/harness-home`. Mend records which skill directories it wrote in
`/workspace/harness-home/.mend-managed-skills.json`, and a digest of their files in
`.mend-managed-skills-digests.json` beside it. On the next delivery it replaces the skills the
libraries still have and moves aside the ones they no longer have. It leaves any skill directory the
agent created itself under another name alone.

A skill directory whose files already match the library is left as it is, so a script you made
executable, an empty directory or a hard link you added stays. Mend never deletes a skill directory.
When the library replaces or drops a skill, its old directory is moved whole, with its modes and
times, to `/workspace/harness-home/.mend/skills-kept/<time>/`, and the server logs where it went.
That covers a skill you or the agent edited during the session, and a directory of the agent's own
that a library skill now shares a name with. Nothing clears `.mend/skills-kept`; delete old entries
there by hand when you no longer need them. To keep an edit in the library, push it with
`mend skills push`.

This works the same in both storage modes. With the captured store, the default, Mend writes the
skills into the running workspace after its harness home is in place. With a co-located store, it
writes them into the session's harness home on the server before the workspace starts.

Delivery happens when the workspace is created, so a new session, or a resume into a fresh
workspace, gets the libraries as they are at that moment. A running session keeps the skills it
started with. When a library changes, Mend rebuilds the project's standby workspaces (see
[Hot sessions](/guides/project-environment/#hot-sessions)) so a claimed standby carries the new
skills.

A launch never fails because of skills. If Mend cannot write them, the session starts without them
and the server logs a warning.

## Claude Code plugins

Claude Code plugins are not kept in a library. Mend installs the ones your settings enable before
Claude starts, in every Claude session: terminal or conversation, from the CLI, the web app, the
phone or Slack. It reads `enabledPlugins` from:

1. your own `~/.claude/settings.json`, which your [dotfiles](/guides/dotfiles/) can carry;
2. the repository's `.claude/settings.json`;
3. the repository's `.claude/settings.local.json`.

A later file wins, so `false` in the repository turns off a plugin your own settings enable. A
plugin that is already installed is skipped. A marketplace Claude does not know yet is added from
`extraKnownMarketplaces` in the same files: a GitHub repository, a git or https URL without
credentials in it, or a path. For example, a repository that wants
[pstack](https://github.com/ypanagidis/pstack) in every session commits:

```json
{
  "enabledPlugins": { "pstack@pstack-claude": true },
  "extraKnownMarketplaces": {
    "pstack-claude": { "source": { "source": "github", "repo": "ypanagidis/pstack" } }
  }
}
```

The install runs as the person whose Claude it is, into their own `~/.claude`, and takes about 2 s
for a plugin from GitHub. All installs at one launch share 30 seconds. A plugin that cannot be
installed in that time, or at all, does not stop the launch: Claude starts without it. The terminal
shows one line before Claude starts:

```text
mend: Claude plugins · installed: pstack@pstack-claude
```

A conversation session writes the same line to its process's stderr, which the conversation view
does not show. A new workspace installs the plugins again: Mend does not save `~/.claude/plugins`
between workspaces yet. A conversation that
[shared control](/reference/known-issues/#shared-control) moved into its own neutral home installs
none.

## Limits

| Limit              | Value                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Skill name         | Up to 64 characters: lowercase letters, digits, `.`, `-` and `_`, starting with a letter or digit |
| Description        | Up to 1,024 characters                                                                            |
| Files per skill    | 64, including `SKILL.md`                                                                          |
| Size of one file   | 512 KB                                                                                            |
| Size of one skill  | 2 MB                                                                                              |
| Skills per library | 200                                                                                               |

Skills are text. File paths are relative to the bundle and may not start with `/` or contain `..`.
One `mend skills push` request is also bounded by the server's upload body budget,
`MEND_BUDGET_UPLOAD_BODY_BYTES` (24 MB by default).
