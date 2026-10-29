import * as fs from "node:fs";
import * as path from "node:path";

import { PageId, type SessionId } from "@mend/domain";
import { PageRef } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { sessionStatePathOf } from "@mend/store";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { TranscriptEntry } from "../src/transcript-pages.ts";
import { sessionPagesLayerOf, setup, withEngine, type World } from "./engine/fixture.ts";
import { CODEX_OUTPUTS, claudePageTranscript, codexPageTranscript } from "./page-transcripts.ts";

const PLACED = PageId.make("0b9e2f4a-6c1d-4f3e-8a7b-2d5c9e1f0a63");
const UNPLACED = PageId.make("7d1a3c5e-9f2b-4a6d-8c0e-4b3f1a2d5c97");
const FOREIGN = PageId.make("c4e6a8b0-2d4f-4a1c-9e3b-5f7d9b1c3e05");

const pageOf = (id: PageId, sessionId: SessionId, title: string) =>
  new PageRef({ id, sessionId, title, height: 420, publishedAt: new Date() });

const shape = (events: ReadonlyArray<TranscriptEntry>) =>
  events.map((event) => (event.kind === "page" ? `page:${event.page.id}` : event.kind));

const provision = (tmp: string, world: World, harness: "claude" | "codex") =>
  Effect.gen(function* () {
    const project = yield* setup(tmp, world);
    const engine = yield* SessionEngine;
    const session = yield* engine.provision({
      projectId: project.id,
      harness,
      label: null,
      name: null,
      ownerUserId: "user-fixture",
      start: { kind: "base", base: null },
    });
    return { project, session, engine };
  });

describe("the transcript shows the session's pages where the agent published them", () => {
  it.each([
    ["claude", "tool_result", claudePageTranscript],
    ...Object.entries(CODEX_OUTPUTS).map(
      ([outputShape, output]) =>
        [
          "codex",
          outputShape,
          (ids: ReadonlyArray<string>) => codexPageTranscript(ids, output),
        ] as const,
    ),
  ] as const)(
    "%s (%s), settled: in place of the html_render call that names it, an unplaced one at the end, a forged id nowhere",
    async (harness, _shape, transcriptOf) => {
      const pages: Array<PageRef> = [];
      const events = await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { project, session, engine } = yield* provision(tmp, world, harness);
            const stateDir = sessionStatePathOf(project.storePath, session.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "transcript.native"),
              transcriptOf([PLACED, FOREIGN]),
            );
            pages.push(
              pageOf(PLACED, session.id, "Latency 0"),
              pageOf(UNPLACED, session.id, "Not yet in the transcript"),
            );
            return (yield* engine.transcript(session.id)).events;
          }),
        { pagesLayer: sessionPagesLayerOf(pages) },
      );
      expect(shape(events)).toEqual([
        "user",
        ...(harness === "claude" ? ["tool"] : []),
        `page:${PLACED}`,
        "tool",
        "assistant",
        `page:${UNPLACED}`,
      ]);
      for (const event of events) {
        if (event.kind === "tool") expect(typeof event.output).toBe("string");
      }
      const placed = events.find((event) => event.kind === "page");
      expect(placed?.kind === "page" ? placed.page : null).toEqual(pages[0]);
    },
    30_000,
  );
});
