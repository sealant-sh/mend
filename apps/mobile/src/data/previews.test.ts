import { describe, expect, it } from "vitest";

import {
  browserFailureOf,
  browserRefusalOf,
  openPreviewIn,
  previewOpenFailureLine,
  previewRowsOf,
  previewToOpen,
  type WorktreePreviewsDto,
} from "./previews";

const SESSION = "session-1";

const preview = (
  serviceName: string,
  input: {
    readonly open?: string | null;
    readonly sessionId?: string;
    readonly facts?: ReadonlyArray<unknown>;
    readonly status?: ReadonlyArray<string>;
  } = {},
): WorktreePreviewsDto["previews"][number] => ({
  preview: { id: `preview-${serviceName}`, serviceName },
  status: input.status ?? [],
  facts: input.facts ?? [],
  open: input.open ?? null,
  boundTo:
    input.sessionId === undefined ? null : { serviceId: "service-1", sessionId: input.sessionId },
});

const read = (
  routing: Exclude<WorktreePreviewsDto["routing"], undefined>,
  ...previews: ReadonlyArray<WorktreePreviewsDto["previews"][number]>
): WorktreePreviewsDto => ({ previews, unprepared: null, starting: false, routing });

const served = (name: string) => `/preview-auth?preview=preview-${name}&path=%2F`;

describe("the session's Preview action", () => {
  it("shows for a preview the gateway serves on a domain or the tailnet", () => {
    for (const routing of ["domain-https", "tailnet-https"] as const) {
      expect(
        previewToOpen(read(routing, preview("web", { open: served("web") })), SESSION),
      ).toEqual({ id: "preview-web", serviceName: "web", open: served("web") });
    }
  });

  it("never shows on loopback routing, which a phone cannot reach", () => {
    expect(
      previewToOpen(read("loopback-http", preview("web", { open: served("web") })), SESSION),
    ).toBeNull();
  });

  it("never shows while previews are off, or for a server that does not say how it routes them", () => {
    expect(previewToOpen(read(null, preview("web", { open: served("web") })), SESSION)).toBeNull();
    expect(
      previewToOpen(
        { previews: [preview("web", { open: served("web") })], unprepared: null },
        SESSION,
      ),
    ).toBeNull();
    expect(previewToOpen(undefined, SESSION)).toBeNull();
  });

  it("offers no Preview action for a stopped explicit run, and still opens the live after app", () => {
    const before = preview("before", { open: null, facts: [] });
    expect(previewToOpen(read("domain-https", before), SESSION)).toBeNull();
    expect(
      previewToOpen(
        read("domain-https", before, preview("after", { open: served("after") })),
        SESSION,
      )?.serviceName,
    ).toBe("after");
  });

  it("never shows when no preview has an Open", () => {
    expect(previewToOpen(read("domain-https", preview("web")), SESSION)).toBeNull();
    expect(previewToOpen(read("domain-https"), SESSION)).toBeNull();
  });

  it("opens this session's own preview before one a sibling session runs", () => {
    const worktree = read(
      "tailnet-https",
      preview("docs", { open: served("docs"), sessionId: "session-2" }),
      preview("raw"),
      preview("web", { open: served("web"), sessionId: SESSION }),
    );
    expect(previewToOpen(worktree, SESSION)?.serviceName).toBe("web");
    expect(previewToOpen(worktree, "session-3")?.serviceName).toBe("docs");
  });
});

describe("the preview status lines on the phone", () => {
  const now = new Date("2026-10-30T12:00:10.000Z");

  it("words each fact with the phone's own clock, as the web does", () => {
    const rows = previewRowsOf(
      read(
        "domain-https",
        preview("web", {
          facts: [
            {
              _tag: "Observed",
              service: "web",
              reachable: true,
              httpStatus: 200,
              observedAt: "2026-10-30T12:00:06.000Z",
            },
            { _tag: "SetupInputsChanged" },
          ],
        }),
        preview("docs", { facts: [{ _tag: "Starting", service: "docs", phase: "setup" }] }),
      ),
      now,
    );
    expect(rows).toEqual([
      {
        key: "preview-web",
        serviceName: "web",
        lines: [
          "preview · web · answered HTTP 200 · observed 4 s ago",
          "setup inputs changed · restart to apply",
        ],
      },
      { key: "preview-docs", serviceName: "docs", lines: ["preview · docs · starting · setup"] },
    ]);
  });

  it("leaves out a preview with nothing to say", () => {
    expect(
      previewRowsOf(read("domain-https", preview("web", { open: served("web") })), now),
    ).toEqual([]);
  });

  it("keeps the server's words for a fact this phone does not know", () => {
    const rows = previewRowsOf(
      read(
        "domain-https",
        preview("docs", {
          facts: [
            { _tag: "SomethingNewer", service: "docs" },
            { _tag: "Starting", service: "docs", phase: "setup" },
          ],
          status: ["preview · docs · something newer", "preview · docs · starting · setup"],
        }),
      ),
      now,
    );
    expect(rows).toEqual([
      {
        key: "preview-docs",
        serviceName: "docs",
        lines: ["preview · docs · something newer", "preview · docs · starting · setup"],
      },
    ]);
  });

  it("shows the server's words when it sends no facts", () => {
    const fromBefore: WorktreePreviewsDto = {
      previews: [
        {
          preview: { id: "preview-web", serviceName: "web" },
          status: ["preview · web · answered HTTP 200 · observed 4 s ago"],
        },
      ],
      unprepared: null,
    };
    expect(previewRowsOf(fromBefore, now)).toEqual([
      {
        key: "preview-web",
        serviceName: "web",
        lines: ["preview · web · answered HTTP 200 · observed 4 s ago"],
      },
    ]);
  });
});

const reservedBrowser = () => {
  const seen: { shown: Array<string>; abandoned: number } = { shown: [], abandoned: 0 };
  let answer: string | null = null;
  return {
    seen,
    answer: (reason: string | null) => (answer = reason),
    browser: {
      show: (url: string) => {
        seen.shown.push(url);
        return Promise.resolve(answer);
      },
      abandon: () => (seen.abandoned += 1),
    },
  };
};

describe("opening a preview", () => {
  it("shows the minted URL in the browser reserved at the press", async () => {
    const reserved = reservedBrowser();
    const failures: Array<string> = [];
    await openPreviewIn(
      reserved.browser,
      () => Promise.resolve({ url: "https://preview.test/__mend/auth?ticket=t&path=%2F" }),
      (reason) => failures.push(reason),
    );
    await Promise.resolve();
    expect(reserved.seen).toEqual({
      shown: ["https://preview.test/__mend/auth?ticket=t&path=%2F"],
      abandoned: 0,
    });
    expect(failures).toEqual([]);
  });

  it("says when the browser does not open what was minted", async () => {
    const reserved = reservedBrowser();
    reserved.answer("another in-app browser is already open");
    const failures: Array<string> = [];
    await openPreviewIn(
      reserved.browser,
      () => Promise.resolve({ url: "https://preview.test/x" }),
      (reason) => failures.push(reason),
    );
    await Promise.resolve();
    expect(failures).toEqual(["another in-app browser is already open"]);
  });

  it("gives back the reserved browser when the server refuses, and passes the refusal on", async () => {
    const reserved = reservedBrowser();
    await expect(
      openPreviewIn(
        reserved.browser,
        () => Promise.reject(new Error("preview · web · nothing to open")),
        () => undefined,
      ),
    ).rejects.toThrow("preview · web · nothing to open");
    expect(reserved.seen).toEqual({ shown: [], abandoned: 1 });
  });

  it("reads expo-web-browser's answers: locked is a refusal, a rejection is its message", () => {
    expect(browserRefusalOf({ type: "locked" })).toBe("another in-app browser is already open");
    for (const type of ["opened", "cancel", "dismiss"])
      expect(browserRefusalOf({ type })).toBeNull();
    expect(browserFailureOf(new Error("No matching browser activity found"))).toBe(
      "No matching browser activity found",
    );
  });

  it("words a refusal in the server's words, and a browser failure as the browser's", () => {
    expect(previewOpenFailureLine({ _tag: "Refused", message: "Previews are off." })).toBe(
      "preview · Previews are off.",
    );
    expect(previewOpenFailureLine({ _tag: "Refused", message: "web · nothing to open" })).toBe(
      "preview · web · nothing to open",
    );
    expect(
      previewOpenFailureLine({ _tag: "BrowserFailed", reason: "the browser blocked the new tab" }),
    ).toBe("preview · the in-app browser did not open · the browser blocked the new tab");
  });
});
