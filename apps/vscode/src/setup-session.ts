import * as vscode from "vscode";

import type { MendClient } from "./client.js";
import type { Launches } from "./launches.js";
import type { SessionStore } from "./session-store.js";
import type { Project } from "./types.js";

const ACTION = "Set up this project";
const NOT_NOW = "Not now";
const CONSENT =
  "A setup session studies the repository and proposes .mend/ files for you to review. It uses your own agent login. Writing these files starts no commands, Services or resources.";

/** The adoption offer and palette command share explicit consent and the existing launch tracking. */
export class SetupSessions {
  constructor(
    private readonly client: Pick<MendClient, "bind">,
    private readonly store: Pick<SessionStore, "showCreated">,
    private readonly launches: Launches,
  ) {}

  /** Not now, dismissal and a dismissed agent picker create no session. */
  async offer(project: Project): Promise<void> {
    const bound = await this.client.bind();
    const consent = await vscode.window.showInformationMessage(CONSENT, ACTION, NOT_NOW);
    if (consent !== ACTION) return;
    const agent = await vscode.window.showQuickPick(["claude", "codex"], {
      title: ACTION,
      placeHolder: "Choose the agent whose own login this session uses",
      ignoreFocusOut: true,
    });
    if (agent === undefined) return;
    const created = await bound.createSession(project.id, {
      harness: agent,
      mode: "pty",
      purpose: "setup",
      label: null,
      name: null,
      base: null,
    });
    this.store.showCreated(created);
    void this.launches.launch(created.id, { mode: "pty" }, { client: bound });
  }
}
