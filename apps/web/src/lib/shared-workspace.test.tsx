import { OrganizationView } from "@mend/api-contracts";
import { OrganizationId, WorktreeId } from "@mend/domain";
import {
  JOIN_SHARED_HOME_LINE,
  joinWorktreeLine,
  Organization,
  retirementStopLines,
  SHARED_CONTROL_LINE,
  SHARED_CONTROL_LINE_OWNER_LOGINS,
  sharedControlConfirm,
  sharedControlLine,
  WorkspaceRetirement,
  WorkspaceRetirementStop,
} from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { refusedWith } from "./refusal-fixture.ts";
import {
  canEndWaitingWork,
  replaceRefusalWords,
  replaceWorkspaceBody,
  retirementRelevant,
  retirementView,
  sharedControlClick,
  WAIT_POLL_MS,
  waitingLineQuery,
  waitingLineRelevant,
  useWorktreeJoinLine,
  worktreeJoin,
  worktreeJoinLine,
} from "./shared-workspace.ts";
import { makeTrpcProxy, TRPCProvider, trpcClient } from "./trpc.ts";

const here = WorktreeId.make("worktree-1");
const elsewhere = WorktreeId.make("worktree-2");
const names = new Map([
  ["alice", "Alice"],
  ["bob", "Bob"],
  ["carol", "Carol"],
]);

type Row = Parameters<typeof worktreeJoin>[0][number];
const row = (
  ownerUserId: string | null,
  status: Row["status"] = "running",
  worktreeId: Row["worktreeId"] = here,
  livePeople: Row["livePeople"] = [],
): Row => ({ worktreeId, ownerUserId, status, livePeople });
const alice = { accountId: "alice", name: "Alice" };
const bob = { accountId: "bob", name: "Bob" };
const dana = { accountId: "dana", name: "Dana" };

describe("the join line in a per-person executor", () => {
  it("names the people the live sessions list in their executor, never the viewer", () => {
    const sessions = [
      row("alice", "running", here, [alice]),
      row("bob", "idle", here, [alice, bob]),
    ];
    expect(worktreeJoinLine(sessions, here, "bob")).toBe(joinWorktreeLine(["Alice"]));
    expect(worktreeJoinLine(sessions, here, "carol")).toBe(joinWorktreeLine(["Alice", "Bob"]));
  });

  it("names someone listed live in the viewer's own session (a steerer)", () => {
    const steered = row("bob", "running", here, [bob, dana]);
    expect(worktreeJoin([steered], here, "bob")).toEqual({ kind: "per-person", names: ["Dana"] });
    expect(worktreeJoinLine([steered], here, "bob")).toBe(joinWorktreeLine(["Dana"]));
  });

  it("says another person when someone else's session is live but only the viewer is listed", () => {
    const sessions = [row("alice"), row("bob", "running", here, [bob])];
    expect(worktreeJoinLine(sessions, here, "bob")).toBe(joinWorktreeLine([]));
  });
});

describe("the join line in a shared executor", () => {
  it("says the workspace shares one home when another person's session runs and nobody is listed", () => {
    expect(worktreeJoin([row("alice")], here, "bob")).toEqual({ kind: "shared-home" });
    expect(worktreeJoinLine([row("alice"), row("bob")], here, "bob")).toBe(JOIN_SHARED_HOME_LINE);
  });

  it("never names anyone there", () => {
    const line = worktreeJoinLine([row("alice"), row("carol")], here, "bob");
    expect(line).toBe(JOIN_SHARED_HOME_LINE);
    expect(line).not.toContain("Alice");
  });
});

describe("the join line says nothing", () => {
  it("for the viewer's own sessions, settled ones, another worktree, or no viewer", () => {
    expect(worktreeJoinLine([row("bob")], here, "bob")).toBeNull();
    expect(worktreeJoinLine([row("bob", "running", here, [bob])], here, "bob")).toBeNull();
    expect(worktreeJoinLine([row("alice", "completed", here, [alice])], here, "bob")).toBeNull();
    expect(worktreeJoinLine([row("alice", "completed")], here, "bob")).toBeNull();
    expect(worktreeJoinLine([row("alice", "running", elsewhere, [alice])], here, "bob")).toBeNull();
    expect(worktreeJoinLine([row("alice", "running", elsewhere)], here, "bob")).toBeNull();
    expect(worktreeJoinLine([row("alice")], here, null)).toBeNull();
  });
});

const checkedAtForViewer = new Date("2026-10-08T09:00:00Z");

describe("what the join line asks for", () => {
  const viewerView = new OrganizationView({
    organization: new Organization({
      id: OrganizationId.make("org-1"),
      name: "Sealant",
      createdByUserId: null,
      createdAt: checkedAtForViewer,
      updatedAt: checkedAtForViewer,
    }),
    userId: "bob",
    role: "member",
    memberCount: 2,
    operator: false,
    tenancy: "single",
    mountDelivery: "bind",
  });

  const render = (sessions: ReadonlyArray<Row>) => {
    const queryClient = new QueryClient();
    const trpc = makeTrpcProxy(queryClient);
    // The page has already read who is looking.
    queryClient.setQueryData(trpc.organization.current.queryKey(), viewerView);
    const Probe = () => <p>{useWorktreeJoinLine(here, sessions) ?? "nothing"}</p>;
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <Probe />
        </TRPCProvider>
      </QueryClientProvider>,
    );
    const asked = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.queryKey));
    return { markup, asked, trpc };
  };

  it("reads only the viewer the page holds: never the organization's members", () => {
    for (const sessions of [[row("alice", "running", here, [alice])], [row("alice")], []]) {
      const { asked, trpc } = render(sessions);
      expect(asked).toEqual([JSON.stringify(trpc.organization.current.queryKey())]);
      expect(asked.join()).not.toContain("members");
    }
  });

  it("says the line from the cached viewer and the sessions' own names", () => {
    expect(render([row("alice", "running", here, [alice])]).markup).toContain(
      "Alice&#x27;s session",
    );
    expect(render([row("alice")]).markup).toContain("shares one home");
    expect(render([]).markup).toBe("<p>nothing</p>");
  });
});

const checkedAt = new Date("2026-10-08T12:05:00Z");

const retirement = (
  fields: Partial<ConstructorParameters<typeof WorkspaceRetirement>[0]> = {},
): WorkspaceRetirement =>
  new WorkspaceRetirement({
    state: "marked",
    preRelease: true,
    launcher: "alice",
    stops: [
      new WorkspaceRetirementStop({ kind: "terminal", label: "claude — fix login" }),
      new WorkspaceRetirementStop({ kind: "service", label: "web on :3000" }),
      new WorkspaceRetirementStop({ kind: "process", label: "python (pid 31)" }),
    ],
    reason: null,
    checkedAt,
    fingerprint: "fp-1",
    canReplace: true,
    ...fields,
  });

describe("the retirement view", () => {
  it("names the launcher and lists, as evidence, what was checked and what would stop", () => {
    const view = retirementView(retirement(), names, []);
    expect(view.line).toBe(
      "This workspace started before Mend 0.36 and shares one home · it takes only Alice's sessions and turns until it is replaced",
    );
    expect(view.stops).toEqual(retirementStopLines(retirement()));
    expect(view.stops[0]).toContain("Checked at 12:05 UTC");
    expect(view.stops).toContain("process Mend did not start · python (pid 31)");
    expect(view.canReplace).toBe(true);
  });

  it("shows everyone else the evidence, with a process's kind only, and no action", () => {
    const reader = retirementView(
      retirement({
        canReplace: false,
        stops: [
          new WorkspaceRetirementStop({ kind: "process", label: "" }),
          new WorkspaceRetirementStop({ kind: "container", label: "" }),
        ],
      }),
      names,
      [],
    );
    expect(reader.canReplace).toBe(false);
    expect(reader.stops).toContain("process Mend did not start");
    expect(reader.stops).toContain("running container");
    expect(reader.stops.join("\n")).not.toContain("pid");
  });

  it("offers nothing while it is being replaced", () => {
    const retiring = retirementView(retirement({ state: "retiring" }), names, []);
    expect(retiring.canReplace).toBe(false);
    expect(retiring.stops).toEqual([]);
    expect(retiring.line).toContain("Replacing this workspace");
  });

  it("takes the launcher's name from the live people when the roster lacks it", () => {
    const view = retirementView(
      retirement({ launcher: "erin", reason: "a shell is open" }),
      names,
      [{ accountId: "erin", name: "Erin" }],
    );
    expect(view.line).toContain("Erin's sessions");
    expect(view.line.endsWith(" · a shell is open")).toBe(true);
  });
});

describe("a replacement", () => {
  it("names the retirement the owner was shown", () => {
    expect(replaceWorkspaceBody(retirement({ fingerprint: "fp-42" }))).toEqual({ seen: "fp-42" });
  });

  it("shows a refusal in the server's words", () => {
    const words =
      "What would stop has changed since you looked. Nothing was stopped; look at the list again and replace it from there.";
    expect(replaceRefusalWords(refusedWith("WorkspaceReplaceRefused", words))).toBe(words);
    expect(replaceRefusalWords(refusedWith(null, "The Mend server is not answering."))).toBe(
      "The Mend server is not answering.",
    );
    expect(replaceRefusalWords(new Error(""))).toBe("The workspace was not replaced.");
  });
});

describe("what the session page asks for", () => {
  const on = new Date("2026-10-08T09:00:00Z");

  it("asks for the waiting line only where people run and control is shared", () => {
    expect(waitingLineRelevant({ livePeople: [alice], sharedControlEnabledAt: on })).toBe(true);
    expect(waitingLineRelevant({ livePeople: [], sharedControlEnabledAt: on })).toBe(false);
    expect(waitingLineRelevant({ livePeople: [alice], sharedControlEnabledAt: null })).toBe(false);
  });

  it("polls the waiting line only while it can show and the session is live", () => {
    expect(waitingLineQuery({ livePeople: [alice], sharedControlEnabledAt: on }, true)).toEqual({
      enabled: true,
      refetchInterval: WAIT_POLL_MS,
    });
    expect(waitingLineQuery({ livePeople: [alice], sharedControlEnabledAt: on }, false)).toEqual({
      enabled: true,
      refetchInterval: false,
    });
    // With the flag off (nobody listed) or control not shared: nothing at all.
    expect(waitingLineQuery({ livePeople: [], sharedControlEnabledAt: on }, true)).toEqual({
      enabled: false,
      refetchInterval: false,
    });
    expect(waitingLineQuery({ livePeople: [alice], sharedControlEnabledAt: null }, true)).toEqual({
      enabled: false,
      refetchInterval: false,
    });
  });

  it("asks for the retirement only when the session says one is under way", () => {
    expect(retirementRelevant({ workspaceRetirement: null })).toBe(false);
    expect(retirementRelevant({ workspaceRetirement: "marked" })).toBe(true);
    expect(retirementRelevant({ workspaceRetirement: "retiring" })).toBe(true);
  });
});

const waitFacts = (viewerId: string | null, steer: boolean) => ({
  viewerId,
  ownerUserId: "alice",
  runsAs: "bob",
  steer,
});

describe("ending the work a turn waits for", () => {
  it("is the session's owner's, whether or not they could steer", () => {
    expect(canEndWaitingWork(waitFacts("alice", true))).toBe(true);
    expect(canEndWaitingWork(waitFacts("alice", false))).toBe(true);
  });

  it("is the person the process runs as only while they can steer", () => {
    expect(canEndWaitingWork(waitFacts("bob", true))).toBe(true);
    expect(canEndWaitingWork(waitFacts("bob", false))).toBe(false);
  });

  it("is nobody else's", () => {
    expect(canEndWaitingWork(waitFacts("carol", true))).toBe(false);
    expect(canEndWaitingWork(waitFacts(null, true))).toBe(false);
  });
});

describe("the Shared control switch", () => {
  it("asks before turning on, in both layouts, and never before turning off", () => {
    expect(sharedControlClick(true)).toBe("confirm");
    expect(sharedControlClick(false)).toBe("toggle");
  });

  it("asks in words true to whose login a steered turn runs on", () => {
    expect(sharedControlConfirm(true).body).toBe(SHARED_CONTROL_LINE);
    expect(sharedControlConfirm(false).body).toContain(SHARED_CONTROL_LINE_OWNER_LOGINS);
    expect(sharedControlConfirm(false).body).not.toContain("sender's login");
  });

  it("says whose logins a steered turn runs on", () => {
    expect(sharedControlLine(true)).toBe(SHARED_CONTROL_LINE);
    expect(sharedControlLine(false)).toBe(SHARED_CONTROL_LINE_OWNER_LOGINS);
  });
});
