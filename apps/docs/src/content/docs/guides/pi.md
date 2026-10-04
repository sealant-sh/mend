---
title: Your pi setup
description:
  Send your pi extensions, themes, packages and settings to Mend once, and every pi session you
  start has them.
sidebar:
  order: 9
---

[pi](https://pi.dev) is shaped by what you add to it: extensions, packages, themes, prompt
templates, settings. `mend connect pi` reads that setup from your machine and saves it as your **pi
profile**. Every pi session you start receives it, so pi in a session works as it does on your
laptop.

```sh
mend connect pi --dry-run   # what would be sent, and what stays here
mend connect pi             # send it
```

The profile is yours alone: it goes into your own pi sessions, never anyone else's. Run the command
again after you change your setup. A session already running keeps the profile it started with.

## What it carries

`mend connect pi` reads pi's agent directory, `~/.pi/agent` or `$PI_CODING_AGENT_DIR`
(`--dir <path>` reads another):

- `extensions/`, `themes/` and `prompts/`, whole;
- `settings.json`, except pi's own record of the last changelog it showed;
- `package.json` and `package-lock.json`, when your extensions share dependencies through them;
- `mcp.json` and `keybindings.json`. `mcp.json` goes as it is, with any keys in it.

Links are followed, so a setup that a tool such as Home Manager links in from elsewhere is read as
the files it points at. A package that `settings.json` names by local path, such as a directory in
the Nix store, is copied into the profile, and the profile's `settings.json` points at the copy. npm
and git packages stay as declared.

It leaves behind:

- `auth.json`. pi runs on your ChatGPT login, the one `mend connect codex` made
  ([provider logins](/concepts/provider-logins/#pi-and-opencode)).
- `skills/`. Send skills with [`mend skills push`](/guides/skills/), which delivers them to every
  harness.
- `AGENTS.md`. Mend writes its own workspace note there.
- Sessions, installed packages (`npm/`, `git/`, `node_modules/`), caches and anything else pi keeps
  about this machine.

The dry run lists all of it, and warns about an MCP server whose command is a path on your machine
that a session may not have.

A profile holds at most 4,000 files and 16 MB, with no single file over 8 MB.

## What a session does with it

The profile lands in the session's harness home, at `~/.pi/agent/mend/profile`. Before pi starts,
the session:

1. Installs what your extensions import: from the profile's `package.json`, or from an extension's
   own `package.json` when that one names something the profile's does not. Each bundled local
   package's dependencies are installed the same way.
2. Installs every npm package `settings.json` declares, into pi's own `npm/` directory, with the
   same command pi uses. A package that fails to install is left out of that session, and the
   terminal says why. pi would otherwise stop at startup. git packages are left to pi.
3. Merges your settings into the session's `settings.json`. A setting changed inside the session
   keeps its value; the others take your profile's. The packages are your profile's, followed by any
   you installed in the session.
4. Copies `mcp.json` and `keybindings.json` into place, unless the session changed its copy.

Each step prints a line starting with `mend:` in the terminal. None of them stops pi from starting.

Before those steps, a pi session is set up to run on your profile or on none. In a remote workspace
the agent state belongs to the worktree, so it can hold the profile and settings of whoever's pi
session ran there last:

- A profile directory that is not exactly the profile being delivered is moved whole to
  `.mend/pi-profile-kept/` in the harness home: someone else's profile, or yours with an extension
  the agent edited.
- What an earlier delivery put into `settings.json` is taken back out. A copy of every file this
  touches goes beside the moved profile first. A setting the session changed keeps its value, and a
  package the session installed stays; a delivered package goes even where the session turned one of
  its extensions off, since pi matches it by its source.
- In a remote workspace, `.mend/pi-profile-kept/` is never saved: what is set aside there lasts as
  long as that session's machine.

When any of this cannot be done, the session does not start, and it says why
(`PI_PROFILE_NOT_DELIVERED`). A `settings.json` or delivery record that does not parse is one such
case: it is left as it is, and the session says which file to fix. A pi session that would join a
workspace where another person's pi is running does not start either (`PI_PROFILE_IN_USE`): pi runs
on one person's profile at a time.

## Packages that build native code

Some packages compile native code when they install, and need `make`, a C compiler and Python. A
workspace image without them cannot install such a package: `@plannotator/pi-extension` is one, for
its terminal. The session then starts pi without it and says so. Add the build tools to the
project's [workspace image](/guides/workspace-images/) to install it.

## Remove it

```sh
mend connect pi --remove
```

New pi sessions then start with pi's defaults.
