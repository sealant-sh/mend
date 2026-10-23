import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { MendClient } from "./client.js";
import { Launches } from "./launches.js";
import { NewSessionInput } from "./new-session-input.js";
import type { StoreChange } from "./session-store.js";
import { project, receipt } from "./test-handoff.js";
import { json, serve, switchable, type Heard } from "./test-servers.js";
import { fake } from "./test-vscode.js";

vi.mock("vscode", () => import("./test-vscode.js"));

const PROMPT = "Keep this new-session prompt on its original server";
const created = receipt("idle").session;

beforeEach(() => fake.reset());

const world = async () => {
  const heard = { A: new Array<Heard>(), B: new Array<Heard>() };
  const holds = { create: Promise.withResolvers<void>(), read: Promise.withResolvers<void>() };
  const held = { create: false, read: false };
  const reached = { create: Promise.withResolvers<void>(), read: Promise.withResolvers<void>() };
  const a = await serve(heard.A, async (req, res) => {
    const route = req.url ?? "";
    if (req.method === "POST" && route === `/api/projects/${project.id}/sessions`) {
      reached.create.resolve();
      if (held.create) await holds.create.promise;
      return json(res, 200, created);
    }
    if (req.method === "POST" && route === `/api/sessions/${created.id}/launch`)
      return json(res, 429, {
        _tag: "BudgetExceeded",
        message: "Switch diagnostic refused this launch",
        budget: "liveSessions",
        limit: 1,
      });
    if (req.method === "GET" && route === `/api/sessions/${created.id}`) {
      reached.read.resolve();
      if (held.read) await holds.read.promise;
      return json(res, 200, {
        session: created,
        processes: [],
        currentAgent: null,
        launchAdmission: null,
      });
    }
    json(res, 404, { _tag: "NotFound", message: "not here" });
  });
  const b = await serve(heard.B, (_req, res) =>
    json(res, 404, { _tag: "NotFound", message: "The destination has no such session" }),
  );
  const connection = switchable(a);
  const client = new MendClient(connection.connections);
  const launches = new Launches(client, { attempted: () => undefined, forget: () => undefined });
  const stored = new Map<string, unknown>();
  const input = new NewSessionInput(
    {
      globalState: {
        get: (key: string) => stored.get(key),
        update: async (key: string, value: unknown) => void stored.set(key, value),
      },
    },
    client,
    {
      details: () => [],
      model: () => null,
      onDidChange: new vscode.EventEmitter<StoreChange>().event,
      refresh: () => undefined,
      showCreated: () => undefined,
      unmatchedRepository: () => null,
      viewer: () => "dana",
      windowProject: () => null,
    },
    launches,
  );
  const prompt = async () => {
    const before = fake.inputBoxes().length;
    void input.open({ project, join: null });
    await vi.waitFor(() => expect(fake.inputBoxes().length).toBeGreaterThan(before));
    const box = fake.lastInputBox();
    await vi.waitFor(() => expect(box.visible).toBe(true));
    return box;
  };
  const posts = (server: "A" | "B") => heard[server].filter((one) => one.method === "POST");
  return {
    launches,
    holds,
    held,
    reached,
    prompt,
    switchTo: (server: "A" | "B") => connection.switchTo(server === "A" ? a : b),
    posts,
    launchPosts: (server: "A" | "B") =>
      posts(server).filter((one) => one.route.endsWith("/launch")),
  };
};

describe("New session after VS Code connects to another server", () => {
  it("sends its Retry nowhere when the switch lands during the Retry's read", async () => {
    const w = await world();
    const box = await w.prompt();
    box.type(PROMPT);
    box.accept();
    await vi.waitFor(() => expect(w.launchPosts("A")).toHaveLength(1));
    expect((await w.launches.offer(created.id)).kind).toBe("retry");

    w.held.read = true;
    w.reached.read = Promise.withResolvers<void>();
    const retry = w.launches.relaunch(created.id, null);
    await w.reached.read.promise;
    w.switchTo("B");
    w.holds.read.resolve();

    const answer = await retry;
    expect(w.posts("B")).toEqual([]);
    expect(answer).toEqual({ kind: "held" });
    expect(w.launchPosts("A")).toHaveLength(1);
  });

  it("sends its first launch nowhere when the switch lands while Mend answers the create", async () => {
    const w = await world();
    const box = await w.prompt();
    box.type(PROMPT);
    w.held.create = true;
    box.accept();
    await w.reached.create.promise;
    w.switchTo("B");
    w.holds.create.resolve();
    await vi.waitFor(() => expect(w.launches.has(created.id)).toBe(true));
    await w.launches.offer(created.id);

    expect(w.posts("B")).toEqual([]);
    expect(w.launchPosts("A")).toEqual([]);
  });

  it("creates nothing on the new server, and keeps her prompt for the server she typed it on", async () => {
    const w = await world();
    const box = await w.prompt();
    box.type(PROMPT);
    w.switchTo("B");
    box.accept();
    await vi.waitFor(() =>
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Mend could not create the session"),
        "Try again",
      ),
    );

    expect(w.posts("B")).toEqual([]);
    expect(w.posts("A")).toEqual([]);
    w.switchTo("A");
    expect((await w.prompt()).value).toBe(PROMPT);
  });
});
