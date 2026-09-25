import { afterEach, describe, expect, it } from "vitest";

import { landingsFixture } from "#/lib/fixtures";
import {
  invalidateLandings,
  queryClient,
  sessionLandingsQuery,
  sessionProcessesQuery,
} from "#/lib/queries";

const invalidated = (queryKey: ReadonlyArray<unknown>): boolean =>
  queryClient.getQueryState(queryKey)?.isInvalidated ?? false;

describe("landing reads (docs/adr/0007-landing.md)", () => {
  afterEach(() => {
    queryClient.clear();
  });

  it("a landing refreshes every session's read of the change's record, and nothing else", async () => {
    // Two sessions in one worktree read the same record; an event names only one of them.
    const a = sessionLandingsQuery("session-a").queryKey;
    const b = sessionLandingsQuery("session-b").queryKey;
    const processes = sessionProcessesQuery("session-a").queryKey;
    queryClient.setQueryData(a, landingsFixture({ sessionId: "session-a" }));
    queryClient.setQueryData(b, landingsFixture({ sessionId: "session-b", land: false }));
    queryClient.setQueryData(processes, []);

    await invalidateLandings();

    expect(invalidated(a)).toBe(true);
    expect(invalidated(b)).toBe(true);
    expect(invalidated(processes)).toBe(false);
  });
});
