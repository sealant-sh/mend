/**
 * The review screen drawn for real against a canned API: what `s` opens for a session with an
 * agent, and what it says for a `mend run` command that has none. opentui loads through node:ffi,
 * so vitest runs this file with --experimental-ffi (vitest.config.ts).
 */
import { noReviewFollowUpLine } from "@mend/domain/workbench";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewScreen, type ReviewSession } from "./review.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let open: TestRendererSetup | null = null;

afterEach(() => {
  open?.renderer.destroy();
  open = null;
});

const change = { id: "chg-1", sessionId: "ses-1", branch: "mend/session/ses-1", baseSha: "0abc" };
const patch = [
  "diff --git a/notes.txt b/notes.txt",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@ -1 +1,2 @@",
  " one",
  "+two",
  "",
].join("\n");
const file = {
  oldPath: "notes.txt",
  newPath: "notes.txt",
  additions: 1,
  deletions: 0,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, contextHash: "h" }],
};

const routes = (session: ReviewSession): Readonly<Record<string, unknown>> => ({
  "/changes/chg-1/reviews/open": { slice: { id: "slice-1" } },
  "/changes/chg-1/reviews/slice-1/diff": {
    change,
    slice: { id: "slice-1", diffDigest: "digest" },
    checkpointA: { id: "cp-a" },
    checkpointB: { id: "cp-b" },
    patch,
    files: [file],
    anchorFiles: [file],
  },
  "/changes/chg-1/comments": [
    {
      id: "cmt-1",
      file: null,
      line: null,
      endLine: null,
      authorKind: "reviewer",
      authorName: "Verifier",
      body: "Name the second line.",
      suggestion: null,
      state: "open",
      evidence: [],
      sentToSessionId: null,
      createdAt: "2026-10-11T00:00:00.000Z",
    },
  ],
  "/changes/chg-1/tour": null,
  "/changes/chg-1/passes": [],
  "/sessions/ses-1/follow-up": null,
  "/sessions/ses-1": { session },
});

const draw = async (harness: string): Promise<TestRendererSetup> => {
  const session: ReviewSession = {
    id: "ses-1",
    harness,
    label: null,
    branch: change.branch,
    baseSha: change.baseSha,
    status: "completed",
  };
  const answers = routes(session);
  const api = async <T,>(_method: string, route: string): Promise<T> => {
    if (!(route in answers)) throw new Error(`${route} → 404`);
    return JSON.parse(JSON.stringify(answers[route]));
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <ReviewScreen
        ctx={{ config: { url: "http://localhost:3105", token: null }, api }}
        projectName="verify"
        session={session}
        changeId="chg-1"
        onBack={() => undefined}
        onQuit={() => undefined}
      />
    </QueryClientProvider>,
    { width: 140, height: 40 },
  );
  open = setup;
  await settle(setup);
  await act(async () => {
    await setup.waitForFrame((frame) => frame.includes("notes.txt"));
  });
  return setup;
};

const settle = async (setup: TestRendererSetup): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await setup.renderOnce();
};

const press = async (setup: TestRendererSetup, key: string): Promise<void> => {
  await act(async () => {
    setup.mockInput.pressKey(key);
  });
  await settle(setup);
};

describe("sending a review back from the dashboard", () => {
  it("opens the send editor for a session with an agent", async () => {
    const setup = await draw("codex");
    expect(setup.captureCharFrame()).toContain("s draft review");
    await press(setup, "s");
    expect(setup.captureCharFrame()).toContain("send review to session");
  });

  it("says a `mend run` command has no agent to send it to, and opens nothing", async () => {
    // The dashboard opened the editor and the server refused it (RC 0.36.0-next.754, A-F3).
    const setup = await draw("run");
    expect(setup.captureCharFrame()).not.toContain("s draft review");
    await press(setup, "s");
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("send review to session");
    expect(frame).toContain(noReviewFollowUpLine("run").slice(0, 60));
  });
});
