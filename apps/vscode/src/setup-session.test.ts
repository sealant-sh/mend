import { beforeEach, describe, expect, it, vi } from "vitest";

import { MendClient } from "./client.js";
import { Launches } from "./launches.js";
import { SetupSessions } from "./setup-session.js";
import { project, receipt } from "./test-handoff.js";
import { json, serve, switchable, type Heard } from "./test-servers.js";
import { fake, window } from "./test-vscode.js";
import type { Session } from "./types.js";

vi.mock("vscode", () => import("./test-vscode.js"));
beforeEach(() => {
  fake.reset();
  window.showInformationMessage.mockReset();
});

const world = async () => {
  const heard: Heard[] = [];
  const created = receipt().session;
  const url = await serve(heard, (req, res) => {
    if (
      req.method === "POST" &&
      [`/api/projects/${project.id}/sessions`, `/api/sessions/${created.id}/launch`].includes(
        req.url ?? "",
      )
    )
      json(res, 200, created);
    else json(res, 404, {});
  });
  const connection = switchable(url);
  const shown: Session[] = [];
  const launches = new Launches({ attempted: () => undefined, forget: () => undefined });
  const setup = new SetupSessions(
    new MendClient(connection.connections),
    {
      showCreated: (session) => {
        shown.push(session);
      },
    },
    launches,
  );
  return { setup, heard, shown, connection, created };
};

describe("setup from adoption or the command palette", () => {
  it.each(["claude", "codex"])(
    "yes and %s create purpose setup, show the row and use the tracked terminal launch",
    async (agent) => {
      const f = await world();
      window.showInformationMessage.mockResolvedValueOnce("Set up this project");
      window.showQuickPick.mockResolvedValueOnce(agent);
      await f.setup.offer(project);
      await vi.waitFor(() =>
        expect(f.heard.filter((read) => read.method === "POST")).toHaveLength(2),
      );
      expect(
        f.heard
          .filter((read) => read.method === "POST")
          .map((read) => ({ route: read.route, body: JSON.parse(read.body) })),
      ).toEqual([
        {
          route: `/api/projects/${project.id}/sessions`,
          body: {
            harness: agent,
            purpose: "setup",
            mode: "pty",
            label: null,
            name: null,
            base: null,
          },
        },
        { route: `/api/sessions/${f.created.id}/launch`, body: { mode: "pty" } },
      ]);
      expect(f.shown.map((session) => session.id)).toEqual([f.created.id]);
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        "A setup session studies the repository and proposes .mend/ files for you to review. It uses your own agent login. Writing these files starts no commands, Services or resources.",
        "Set up this project",
        "Not now",
      );
    },
  );

  it.each(["Not now", undefined])("%s creates nothing", async (answer) => {
    const f = await world();
    window.showInformationMessage.mockResolvedValueOnce(answer);
    await f.setup.offer(project);
    expect(f.heard.filter((read) => read.method === "POST")).toEqual([]);
    expect(f.shown).toEqual([]);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("dismissed agent selection creates nothing", async () => {
    const f = await world();
    window.showInformationMessage.mockResolvedValueOnce("Set up this project");
    await f.setup.offer(project);
    expect(f.heard.filter((read) => read.method === "POST")).toEqual([]);
  });

  it("keeps the choice bound to its account when the connection changes", async () => {
    const f = await world();
    window.showInformationMessage.mockImplementationOnce(async () => {
      f.connection.switchTo("http://127.0.0.1:1");
      return "Set up this project";
    });
    window.showQuickPick.mockResolvedValueOnce("codex");
    await expect(f.setup.offer(project)).rejects.toThrow("another Mend server");
    expect(f.heard.filter((read) => read.method === "POST")).toEqual([]);
  });
});
