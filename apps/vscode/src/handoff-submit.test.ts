import type { CaptureSummary } from "@mend/local-git/handoff";
import { describe, expect, it } from "vitest";

import { HandoffDraft } from "./handoff-draft.js";
import { HandoffSubmission } from "./handoff-submit.js";
import type { LocalResult } from "./handoff-worker.js";
import { ConnectionChanged, Launches } from "./launches.js";
import { MendApiError } from "./mend-http.js";
import { detail, fakeHandoff, project, receipt, summary } from "./test-handoff.js";
import type { SessionStatus } from "./types.js";

const setup = () => {
  const fake = fakeHandoff();
  const progress: string[] = [];
  const dependencies = {
    launches: new Launches(fake.client, {
      attempted: () => {
        fake.calls.push("attempt");
      },
      forget: () => undefined,
    }),
    progress: (line: string) => {
      progress.push(line);
    },
    record: () => {
      fake.calls.push("record");
    },
    launchConfirmed: () => {
      fake.calls.push("launch confirmed");
    },
    holdTimeoutMs: 2,
    pollMs: 1,
  };
  return { ...fake, dependencies, progress };
};
describe("an accepted handoff", () => {
  it("packs once, records the receipt before launch, and joins repeated acceptance", async () => {
    const f = setup();
    const operation = new HandoffSubmission(
      { ...f.accepted, continuation: { kind: "prompt", prompt: "continue" } },
      f.dependencies,
    );
    const a = operation.run();
    const b = operation.run();
    expect(a).toBe(b);
    expect((await a).kind).toBe("done");
    expect(f.calls.filter((call) => call === "receive")).toHaveLength(1);
    expect(f.calls.indexOf("record")).toBeLessThan(f.calls.indexOf("attempt"));
    expect(f.calls.indexOf("attempt")).toBeLessThan(f.calls.indexOf("launch"));
    expect(f.progress).toEqual([
      "bundling 2 commits · 4 files",
      "uploading 20 B",
      "creating worktree",
      "ready",
    ]);
    await operation.dispose();
    expect(f.calls.at(-1)).toBe("dispose");
  });
  it("holds without launching, and Check again reuses the identical packed artifact", async () => {
    const f = setup();
    f.answers.push({ kind: "unconfirmed" }, { kind: "unconfirmed" }, { kind: "unconfirmed" });
    const operation = new HandoffSubmission(f.accepted, f.dependencies);
    expect((await operation.run()).kind).toBe("unconfirmed");
    f.answers.push({ kind: "received", receipt: { ...receipt(), replayed: true } });
    expect((await operation.checkAgain()).kind).toBe("done");
    expect(f.uploads).toHaveLength(4);
    expect(f.uploads.every((bytes) => bytes === f.uploads[0])).toBe(true);
    expect(f.calls.filter((call) => call === "pack")).toHaveLength(1);
    expect(f.calls).not.toContain("launch");
    await operation.dispose();
  });
  it("never treats a later refusal as proof that an unanswered upload created nothing", async () => {
    const f = setup();
    f.answers.push(
      { kind: "unconfirmed" },
      {
        kind: "refused",
        issue: {
          kind: "refused",
          message: "Too many handoffs in progress · nothing was created",
          reason: null,
          budget: "accountHandoffsInFlight",
          limit: 1,
          retryAfterSeconds: 12,
        },
      },
    );
    const operation = new HandoffSubmission(f.accepted, f.dependencies);
    const first = await operation.run();
    expect(first).toMatchObject({ kind: "unconfirmed", stage: "receive" });
    expect(first.message).toContain("It may have arrived.");
    expect(first.message).toContain("try again in 12 seconds");
    for (const claim of ["Nothing was handed off", "nothing was created", "not sent"])
      expect(first.message).not.toContain(claim);
    f.answers.push({ kind: "received", receipt: { ...receipt(), replayed: true } });
    expect((await operation.checkAgain()).kind).toBe("done");
    expect(f.uploads.every((bytes) => bytes === f.uploads[0])).toBe(true);
    expect(f.calls.filter((call) => call === "pack")).toHaveLength(1);
    await operation.dispose();
  });
  it("stops before mutations when the connection or origin changed", async () => {
    const f = setup();
    f.move();
    expect(await new HandoffSubmission(f.accepted, f.dependencies).run()).toMatchObject({
      kind: "refused",
      issue: { kind: "server-changed" },
    });
    expect(f.calls).not.toContain("receive");
    const changed = {
      ...f.accepted,
      client: { ...f.client, isCurrent: async () => true },
      worker: {
        ...f.worker,
        discover: async () => ({
          kind: "ok" as const,
          value: { ...f.accepted.checkout, originUrl: "https://github.com/foreign/repo" },
        }),
      },
    };
    expect(await new HandoffSubmission(changed, f.dependencies).run()).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("origin changed"),
    });
    expect(f.calls).not.toContain("receive");
  });
  it("stops before the upload when the connection changes while the checkout is read again", async () => {
    const f = setup();
    let reads = 0;
    const worker = {
      ...f.worker,
      discover: async () => {
        reads++;
        if (reads === 2) f.move();
        return f.worker.discover();
      },
    };
    expect(
      await new HandoffSubmission({ ...f.accepted, worker }, f.dependencies).run(),
    ).toMatchObject({ kind: "refused", issue: { kind: "server-changed" } });
    expect(f.calls).not.toContain("receive");
  });
  it("after dispatch sends no launch to the bound destination once VS Code switched, and keeps the prompt", async () => {
    const f = setup();
    const bound = {
      ...f.client,
      receiveBranchHandoff: async () => {
        f.move();
        return { kind: "received" as const, receipt: receipt() };
      },
    };
    const result = await new HandoffSubmission(
      { ...f.accepted, client: bound, continuation: { kind: "prompt", prompt: "continue" } },
      f.dependencies,
    ).run();
    expect(result.kind).toBe("done");
    expect(f.calls).not.toContain("launch");
    expect(f.calls).not.toContain("launch confirmed");
    expect(f.calls).not.toContain("record");
    expect(f.calls).not.toContain("attempt");
  });
  it("adopts nothing and says the connection changed when VS Code switches just before the adoption", async () => {
    const f = setup();
    const client = {
      ...f.client,
      adoptProject: async () => {
        throw new ConnectionChanged();
      },
    };
    const result = await new HandoffSubmission(
      {
        ...f.accepted,
        client,
        projectsBefore: [],
        target: { kind: "adopt", name: project.name, origin: project.originUrl ?? "" },
      },
      f.dependencies,
    ).run();
    expect(result).toMatchObject({ kind: "refused", issue: { kind: "server-changed" } });
    expect(result.message).not.toContain("stays adopted");
    expect(result.message).not.toContain("hasn't confirmed");
    expect(f.calls).not.toContain("receive");
  });
  it("reconciles a lost adoption answer without ever reposting it", async () => {
    const f = setup();
    let found = false;
    const client = {
      ...f.client,
      adoptProject: async () => {
        f.calls.push("adopt");
        throw new MendApiError("no answer", null);
      },
      listProjects: async () => (found ? [project] : []),
    };
    const operation = new HandoffSubmission(
      {
        ...f.accepted,
        client,
        projectsBefore: [],
        target: { kind: "adopt", name: project.name, origin: project.originUrl ?? "" },
      },
      f.dependencies,
    );
    expect(await operation.run()).toMatchObject({ kind: "unconfirmed", stage: "adoption" });
    found = true;
    expect((await operation.checkAgain()).kind).toBe("done");
    expect(f.calls.filter((call) => call === "adopt")).toHaveLength(1);
  });
  it("retains adoption on a changed default and never replaces the displayed snapshot", async () => {
    const f = setup();
    const operation = new HandoffSubmission(
      {
        ...f.accepted,
        target: { kind: "adopt", name: project.name, origin: project.originUrl ?? "" },
        client: { ...f.client, adoptProject: async () => ({ ...project, defaultBranch: "trunk" }) },
      },
      f.dependencies,
    );
    expect(await operation.run()).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("newsroom-api stays adopted. Nothing was handed off."),
    });
    expect(f.calls).not.toContain("receive");
    expect(f.calls).not.toContain("capture");
  });
  it("refuses a missing agent bridge before adoption or receive", async () => {
    const f = setup();
    expect(
      await new HandoffSubmission({ ...f.accepted, needsAgentShare: true }, f.dependencies).run(),
    ).toMatchObject({ kind: "refused", issue: { kind: "bridge-unavailable" } });
    expect(f.calls).not.toContain("receive");
    expect(f.calls).not.toContain("adopt");
  });
  it("rechecks an existing project's default before sending the frozen cut", async () => {
    const f = setup();
    const client = {
      ...f.client,
      listProjects: async () => [{ ...project, defaultBranch: "trunk" }],
    };
    expect(
      await new HandoffSubmission({ ...f.accepted, client }, f.dependencies).run(),
    ).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("default branch or handoff limits changed"),
    });
    expect(f.calls).not.toContain("receive");
  });
  it("rechecks origin after the last terms read, just before sending", async () => {
    const f = setup();
    let reads = 0;
    const worker = {
      ...f.worker,
      discover: async () => ({
        kind: "ok" as const,
        value: {
          ...f.accepted.checkout,
          originUrl:
            ++reads === 1 ? f.accepted.checkout.originUrl : "https://github.com/other/repo.git",
        },
      }),
    };
    expect(
      await new HandoffSubmission({ ...f.accepted, worker }, f.dependencies).run(),
    ).toMatchObject({ kind: "refused", message: expect.stringContaining("origin changed") });
    expect(f.calls).not.toContain("receive");
  });
  it("an observed session event wakes hold startup, and its listener is released", async () => {
    const f = setup();
    f.read(detail("starting"));
    let listening = 0;
    const observe = (id: string, changed: () => void) => {
      expect(id).toBe(receipt().session.id);
      listening++;
      const timer = setTimeout(() => {
        f.read(detail());
        changed();
      }, 1);
      return () => {
        clearTimeout(timer);
        listening--;
      };
    };
    const outcome = await new HandoffSubmission(f.accepted, {
      ...f.dependencies,
      observe,
      holdTimeoutMs: 100,
      pollMs: 1000,
    }).run();
    expect(outcome.kind).toBe("done");
    expect(listening).toBe(0);
    expect(f.calls.filter((call) => call === "detail")).toHaveLength(2);
  });
  it("keeps a lost receipt uncertain when a later request is signed out", async () => {
    const f = setup();
    f.answers.push({ kind: "unconfirmed" }, { kind: "refused", issue: { kind: "signed-out" } });
    expect(await new HandoffSubmission(f.accepted, f.dependencies).run()).toMatchObject({
      kind: "refused",
      issue: { kind: "signed-out" },
      message: expect.stringContaining("It may have arrived."),
    });
    expect(f.uploads).toHaveLength(2);
  });
  it("owns the bridge through hold and launch, then closes it on the outcome", async () => {
    const f = setup();
    const client = {
      ...f.client,
      shareAgent: async () => ({
        snapshot: () => "connected" as const,
        subscribe: () => () => undefined,
        ready: async () => {
          f.calls.push("share-ready");
          return "connected" as const;
        },
        close: async () => {
          f.calls.push("share-closed");
        },
      }),
    };
    await new HandoffSubmission(
      {
        ...f.accepted,
        client,
        needsAgentShare: true,
        continuation: { kind: "prompt", prompt: "continue" },
      },
      f.dependencies,
    ).run();
    expect(f.calls.indexOf("share-ready")).toBeLessThan(f.calls.indexOf("receive"));
    expect(f.calls.indexOf("launch")).toBeLessThan(f.calls.indexOf("share-closed"));
  });
  const statuses: ReadonlyArray<SessionStatus> = [
    "starting",
    "running",
    "waiting",
    "idle",
    "stopping",
    "completed",
    "failed",
    "stopped",
  ];
  it.each(statuses)("a received %s session is observed before continuation", async (status) => {
    const f = setup();
    f.read(detail(status));
    f.answers.push({ kind: "received", receipt: { ...receipt(status), replayed: true } });
    const outcome = await new HandoffSubmission(
      { ...f.accepted, continuation: { kind: "prompt", prompt: "continue" } },
      f.dependencies,
    ).run();
    expect(f.calls).toContain("record");
    expect(f.calls.filter((call) => call === "launch")).toHaveLength(status === "idle" ? 1 : 0);
    expect(outcome.kind).toBe(
      status === "starting" || status === "stopping"
        ? "workspace-pending"
        : ["failed", "stopped", "completed"].includes(status)
          ? "workspace-failed"
          : "done",
    );
  });
  it("keeps a prompt through a slow start, and Check again launches it once the hold is idle", async () => {
    const f = setup();
    f.read(detail("starting"));
    const operation = new HandoffSubmission(
      { ...f.accepted, continuation: { kind: "prompt", prompt: "continue" } },
      f.dependencies,
    );
    const pending = await operation.run();
    expect(pending.kind).toBe("workspace-pending");
    expect(pending.message).toContain("your prompt has not been sent");
    f.read(detail("idle"));
    expect((await operation.checkAgain()).kind).toBe("done");
    expect(f.calls.filter((call) => call === "launch")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "receive")).toHaveLength(1);
    await operation.dispose();
  });
  it("says a prompt was not sent when an agent already runs in the received session", async () => {
    const f = setup();
    f.read(detail("running"));
    const outcome = await new HandoffSubmission(
      { ...f.accepted, continuation: { kind: "prompt", prompt: "continue" } },
      f.dependencies,
    ).run();
    expect(outcome).toMatchObject({ kind: "done" });
    expect(outcome.message).toContain("your prompt was not sent");
    expect(f.calls).not.toContain("launch");
  });
  it("does not replay a prompt if an agent ever started", async () => {
    const f = setup();
    const held = detail();
    f.read({
      ...held,
      processes: [
        {
          id: "agent1",
          kind: "agent-pty",
          harness: "claude",
          status: "completed",
          exitedAt: summary.cutAt,
          providerSessionId: null,
          label: null,
          runsAs: null,
          waiting: null,
        },
      ],
    });
    await new HandoffSubmission(
      { ...f.accepted, continuation: { kind: "prompt", prompt: "continue" } },
      f.dependencies,
    ).run();
    expect(f.calls).not.toContain("launch");
  });
});
describe("draft ownership", () => {
  it("a late superseded capture cannot replace the env choice or be accepted", async () => {
    const f = setup();
    const first = Promise.withResolvers<LocalResult<CaptureSummary>>();
    const second = Promise.withResolvers<LocalResult<CaptureSummary>>();
    const signals: AbortSignal[] = [];
    const worker = {
      ...f.worker,
      capture: async (
        _branch: string | null,
        _bytes: number,
        env: "include" | "exclude",
        signal: AbortSignal,
      ) => {
        signals.push(signal);
        return env === "exclude" ? first.promise : second.promise;
      },
    };
    const draft = new HandoffDraft({ ...f.accepted, worker });
    const old = draft.withEnv("exclude");
    const chosen = draft.withEnv("include");
    expect(signals[0]?.aborted).toBe(true);
    expect(draft.accept("continue")).toBeNull();
    second.resolve({ kind: "ok", value: { ...summary, envFiles: "include" } });
    await chosen;
    first.resolve({ kind: "ok", value: summary });
    expect(await old).toEqual({ _tag: "cancelled" });
    expect(draft.accept("continue")?.summary.envFiles).toBe("include");
    await worker.dispose();
  });
  it("discards on cancellation, and accepted resources transfer once", async () => {
    const f = setup();
    const draft = new HandoffDraft(f.accepted);
    await draft.withEnv("exclude");
    const accepted = draft.accept("continue");
    expect(accepted).not.toBeNull();
    expect(draft.accept("different")).toBe(accepted);
    await draft.discard();
    expect(f.calls).not.toContain("dispose");
    expect(await draft.withEnv("include")).toEqual({ _tag: "cancelled" });
    const cancelled = new HandoffDraft(f.accepted);
    await cancelled.discard();
    expect(cancelled.accept("")).toBeNull();
    expect(f.calls).toContain("dispose");
  });
});
