---
"@sealant/mend": minor
---

Mend's web app is the new one, in the Sheet design. `mend server setup`, `mend server upgrade`, the
Helm chart's `mend-web` image and every preview now serve it, at the same address and port, 3105.
Nothing to migrate: your sessions, projects, settings and sign-ins carry over, and links from the
CLI, Slack, VS Code, pull requests and invitations open the matching page.

What you will see:

- The sidebar is the inbox. Sessions sit under Waiting on you, To review, Running, Snoozed and Done,
  in place of the Now page's Needs you, Ready to review and Settled.
- A session is a workspace of tabs and tiles: the conversation, Change, Checks, Record, Details,
  Terminal, Screen and Preview open side by side and keep their layout.
- Each setting has one home, under your account, this browser, the organization, a project or the
  server, and Settings no longer offers an Inherit choice. Your agent logins and Git are under Agent
  logins and Git; your links to Slack, Executor and Doppler under Connected apps.
- Slack's `settings` reply links to Settings → Connected apps, where your own default project is.
- The desktop app shows the same web app.

The old web app is gone from this release; there is no switch back inside it.
