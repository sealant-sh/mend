import { ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  ResourceName,
  ResourceSpecDigest,
  type WorktreeChoice,
} from "@mend/domain/workbench";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { answered, refusedNote, resourcesRead, settleChoice } from "./resources-card.ts";
import type { ResourcesPageView } from "./resources.ts";

const db = ResourceDefinitionId.make("rdef_db");
const page = (choice: WorktreeChoice | null): ResourcesPageView => ({
  settings: [
    {
      id: db,
      digest: ResourceSpecDigest.make("a".repeat(64)),
      spec: presetDefinition({
        name: ResourceName.make("db"),
        preset: "postgres",
        version: PresetVersion.make("17"),
      }),
      image: `postgres:17@sha256:${"c".repeat(64)}`,
      level: "project",
      worktreeId: null,
      addedBy: "maria",
      choice,
      canRemove: false,
      canChoose: true,
      canLoadOwn: true,
      instance: "not-started",
      statusLine: `@db · ${choice ?? "nothing"}`,
    },
  ],
  file: { kind: "not-selected" },
});
const receipt = { refused: false, lines: ["image postgres:17@sha256:…"], reload: false };

describe("where an act's answer lands", () => {
  it("keeps the answer to an act on the definition the act started on", () => {
    expect(answered(new Map(), "s:rdef_db", { at: "s:rdef_db", note: receipt })).toEqual(
      new Map([["s:rdef_db", receipt]]),
    );
  });

  it("moves a mend.toml table's answer to the definition it became, and clears the table's", () => {
    const before = new Map([["f:db", { refused: true, lines: ["old"], reload: false }]]);
    expect(answered(before, "f:db", { at: "s:rdef_db", note: receipt })).toEqual(
      new Map([["s:rdef_db", receipt]]),
    );
  });

  it("writes each refusal on a line of its own", () => {
    expect(
      refusedNote({ kind: "rejected", message: "@x · worktree is one\n@x · image is sha256:1" })
        .lines,
    ).toEqual(["@x · worktree is one", "@x · image is sha256:1"]);
  });
});

describe("the read on screen", () => {
  const worktree = WorktreeId.make("wt_b");

  it("reads another worktree's kept data as pending, never as this one's", () => {
    expect(
      resourcesRead(
        { status: "success", data: page("project"), error: null, isPlaceholderData: true },
        worktree,
      ),
    ).toEqual({ kind: "pending" });
  });

  it("says a failed read in its words, apart from one in flight", () => {
    expect(
      resourcesRead(
        {
          status: "error",
          data: undefined,
          error: new Error("Not found."),
          isPlaceholderData: false,
        },
        worktree,
      ),
    ).toEqual({ kind: "failed", message: "Not found." });
    expect(
      resourcesRead(
        { status: "pending", data: undefined, error: null, isPlaceholderData: false },
        worktree,
      ),
    ).toEqual({ kind: "pending" });
  });

  it("binds a loaded page to the worktree it was read for", () => {
    expect(
      resourcesRead(
        { status: "success", data: page("worktree"), error: null, isPlaceholderData: false },
        worktree,
      ),
    ).toMatchObject({ kind: "loaded", worktreeId: worktree });
  });
});

describe("a stored choice", () => {
  it("is never overwritten by a read that started before it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ["resources", "wt_b"];
    const earlier: Array<(value: ResourcesPageView) => void> = [];
    const queryFn = vi
      .fn<() => Promise<ResourcesPageView>>()
      .mockImplementationOnce(() => new Promise((resolve) => earlier.push(resolve)))
      .mockImplementation(() => Promise.resolve(page("worktree")));
    const stop = new QueryObserver(client, { queryKey, queryFn }).subscribe(() => undefined);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    await settleChoice(client, queryKey, {
      definitionId: db,
      mode: "worktree",
      statusLine: "@db · own",
    });
    for (const finish of earlier) finish(page("project"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.getQueryData<ResourcesPageView>(queryKey)?.settings[0]?.choice).toBe("worktree");
    expect(queryFn).toHaveBeenCalledTimes(2);
    stop();
  });
});
