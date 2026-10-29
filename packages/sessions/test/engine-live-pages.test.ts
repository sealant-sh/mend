import * as fs from "node:fs";
import * as path from "node:path";

import { SessionPagesRepo, SessionProcessesRepo, SessionsRepo } from "@mend/db";
import {
  PageId,
  SessionId,
  ProjectId,
  OrganizationId,
  SealantWorkspaceId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { PageRef, Project, Session } from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { sessionStatePathOf } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { SessionEngine } from "../src/engine.ts";
import {
  sealantDeadLayer,
  sessionProcessesLayer,
  sessionsLayer,
  withEngine,
} from "./engine/fixture.ts";
import { execAnswer, fakeWorkspace } from "./fake-workspace.ts";

const jsonl = (entries: ReadonlyArray<unknown>) =>
  entries.map((entry) => JSON.stringify(entry)).join("\n");
const output = (id: string) =>
  JSON.stringify({ htmlRender: { attachmentId: id, title: "Page", height: 400 } });

describe("pages in a live and a settled transcript", () => {
  it.each([
    ["claude", "live"],
    ["claude", "settled"],
    ["codex", "live"],
    ["codex", "settled"],
  ])("places %s pages in a %s transcript and rejects a foreign id", async (harness, source) => {
    const pages: PageRef[] = [];
    let liveNative = "";
    let liveReads = 0;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = new Project({
            id: ProjectId.make("p-pages"),
            organizationId: OrganizationId.make("org-pages"),
            name: "Pages",
            visibility: "private",
            createdByUserId: "user-fixture",
            originUrl: null,
            storePath: path.join(tmp, "project.git"),
            defaultBranch: "main",
            adoptedSha: Sha.make("abc"),
            autoTour: "off",
            autoName: "off",
            autoLand: "off",
            autoSuggest: "off",
            backgroundSessions: "off",
            gitAuthMode: "mend-key",
            workspaceImage: null,
            applyDotfiles: false,
            defaultShellProfile: true,
            inheritUserSkills: false,
            hotSessions: 0,
            installCommand: null,
            installEnabled: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          world.projects.set(project.id, project);
          const engine = yield* SessionEngine;
          const session = yield* Effect.flatMap(SessionsRepo, (repo) =>
            repo.create({
              id: SessionId.make("s-pages"),
              projectId: project.id,
              worktreeId: WorktreeId.make("wt-pages"),
              harness,
              label: null,
              ownerUserId: "user-fixture",
              worktree: "pages",
              branch: "mend/pages",
              baseSha: Sha.make("abc"),
              baseRef: "main",
              contextSnapshotId: null,
              origin: "mend",
            }),
          ).pipe(Effect.provide(sessionsLayer(world)));
          world.sessions.set(
            session.id,
            new Session({
              ...session,
              status: source === "live" ? "running" : "completed",
              settledAt: source === "live" ? null : new Date(),
              sealantWorkspaceId: SealantWorkspaceId.make("ws-pages"),
            }),
          );
          const ref = (id: string) =>
            new PageRef({
              id: PageId.make(id),
              sessionId: session.id,
              title: id,
              height: 400,
              publishedAt: new Date(),
            });
          pages.push(ref("placed"), ref("unplaced"));
          pages.push(
            new PageRef({ ...ref("foreign"), sessionId: SessionId.make("another-session") }),
          );
          const withoutNative = yield* engine.transcript(session.id);
          expect(withoutNative.events.map((event) => event.kind)).toEqual(["page", "page"]);
          const call = { html: "<p>PRIVATE PAGE BYTES</p>", title: "Page", height: 400 };
          const native =
            harness === "claude"
              ? jsonl([
                  { type: "user", message: { content: "draw" } },
                  {
                    type: "assistant",
                    message: {
                      content: [
                        {
                          type: "tool_use",
                          id: "c1",
                          name: "mcp__mend__html_render",
                          input: call,
                        },
                        {
                          type: "tool_use",
                          id: "c2",
                          name: "mcp__mend__html_render",
                          input: call,
                        },
                      ],
                    },
                  },
                  {
                    type: "user",
                    message: {
                      content: [
                        { type: "tool_result", tool_use_id: "c1", content: output("placed") },
                        { type: "tool_result", tool_use_id: "c2", content: output("foreign") },
                      ],
                    },
                  },
                  { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } },
                ])
              : jsonl([
                  {
                    type: "response_item",
                    payload: {
                      type: "message",
                      role: "user",
                      content: [{ type: "input_text", text: "draw" }],
                    },
                  },
                  ...["placed", "foreign"].flatMap((id) => [
                    {
                      type: "response_item",
                      payload: {
                        type: "function_call",
                        call_id: id,
                        name: "mcp__mend__html_render",
                        arguments: JSON.stringify(call),
                      },
                    },
                    {
                      type: "response_item",
                      payload: { type: "function_call_output", call_id: id, output: output(id) },
                    },
                  ]),
                  {
                    type: "response_item",
                    payload: {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "Done" }],
                    },
                  },
                ]);
          const state = sessionStatePathOf(project.storePath, session.id);
          if (source === "live") {
            liveNative = native;
            yield* Effect.flatMap(SessionProcessesRepo, (repo) =>
              repo.create({
                sessionId: session.id,
                sealantWorkspaceId: SealantWorkspaceId.make("ws-pages"),
                sealantSessionId: "pty-pages",
                kind: "agent-pty",
                harness,
                label: null,
                argv: [],
              }),
            ).pipe(Effect.provide(sessionProcessesLayer(world)));
          } else {
            fs.mkdirSync(state, { recursive: true });
            fs.writeFileSync(path.join(state, "transcript.native"), native);
          }
          const transcript = yield* engine.transcript(session.id);
          expect(transcript.events.map((event) => event.kind)).toEqual([
            "user",
            "tool",
            "page",
            "tool",
            "assistant",
            "page",
          ]);
          expect(
            transcript.events.flatMap((event) => (event.kind === "page" ? [event.page.id] : [])),
          ).toEqual(["placed", "unplaced"]);
          expect(yield* engine.transcript(session.id)).toEqual(transcript);
          expect(liveReads).toBe(source === "live" ? 2 : 0);
        }),
      {
        sealantLayer: Layer.effect(
          SealantClient,
          Effect.gen(function* () {
            const base = yield* SealantClient;
            return {
              ...base,
              getWorkspace: () => Effect.succeed(fakeWorkspace("ws-pages")),
              exec: (_workspace, argv) =>
                Effect.sync(() => {
                  if (argv[0] !== "cat") return execAnswer("/home/mend/transcript.jsonl");
                  liveReads += 1;
                  return execAnswer(liveNative);
                }),
            };
          }),
        ).pipe(Layer.provide(sealantDeadLayer)),
        pagesLayer: Layer.succeed(SessionPagesRepo, {
          listForSession: (id) => Effect.succeed(pages.filter((page) => page.sessionId === id)),
          byId: () => Effect.succeed(null),
          refById: () => Effect.succeed(null),
          publish: () => Effect.die("not used"),
        }),
      },
    );
  });
});
