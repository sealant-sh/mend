import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckpointId, SequenceNumber, Sha } from "@mend/domain";
import { Checkpoint } from "@mend/domain/workbench";
import { Store, StoreConfig } from "@mend/store";
import { Effect, Layer, type Tracer } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const worktree = ids("private-alice").worktree;
let api: TenancyApi;
let root: string;
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
beforeAll(async () => {
  root = fs.mkdtempSync(join(tmpdir(), "mend-raw-http-"));
  fs.writeFileSync(join(root, "data.bin"), bytes);
  fs.writeFileSync(join(root, "empty.bin"), "");
  fs.symlinkSync("/etc/passwd", join(root, "escape.bin"));
  const store = await Effect.runPromise(
    Effect.provide(Store, Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root)))),
  );
  const checkpoint = new Checkpoint({
    id: CheckpointId.make("checkpoint-raw"),
    worktreeId: worktree,
    sessionId: null,
    ordinal: 0,
    ref: "refs/mend/test",
    sha: Sha.make("a".repeat(40)),
    sealantRunId: null,
    seq: SequenceNumber.make(0n),
    trigger: "session-start",
    createdAt: new Date(),
  });
  api = await createTenancyApi(
    {},
    {
      sessionStore: "colocated",
      browserHeaders: true,
      implement: {
        reads: {
          openRawFile: (_project, _worktree, target) =>
            store.openRawWorktreeFile(root, target.path, target.within),
        },
        checkpoints: {
          listForWorktree: () =>
            Effect.succeed([
              checkpoint,
              new Checkpoint({
                ...checkpoint,
                id: CheckpointId.make("checkpoint-foreign"),
                worktreeId: ids("shared-b").worktree,
              }),
            ]),
        },
      },
    },
  );
});
afterAll(async () => {
  await api?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
const get = (query = "path=data.bin", headers = {}, method = "GET") =>
  api.request("alice", method, `/api/worktrees/${worktree}/raw?${query}`, undefined, headers);

it("serves exact binary bytes, full 200, empty files and HEAD metadata", async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("x-mend-file-path")).toBe("data.bin");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  const head = await get(undefined, { range: "bytes=1-2" }, "HEAD");
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe("256");
  expect(await head.text()).toBe("");
  expect((await get("path=empty.bin")).status).toBe(200);
});
it("answers single ranges exactly, unsatisfiable 416, and malformed or If-Range full 200", async () => {
  for (const [range, start, end] of [
    ["bytes=0-0", 0, 0],
    ["bytes=2-5", 2, 5],
    ["BYTES=253-", 253, 255],
    ["bytes=-3", 253, 255],
    ["bytes=-999", 0, 255],
    ["bytes=0-999999999999999999999999", 0, 255],
  ] as const) {
    const response = await get(undefined, { range });
    expect(response.status, range).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/256`);
    expect(response.headers.get("content-length")).toBe(String(end - start + 1));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(start, end + 1));
  }
  for (const range of ["bytes=256-", "bytes=-0", "bytes=999999999999999999999999-"]) {
    const response = await get(undefined, { range });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */256");
    expect(await response.text()).toBe("");
  }
  expect((await get("path=empty.bin", { range: "bytes=0-" })).status).toBe(416);
  for (const range of ["bytes=2-1", "bytes=-", "bytes=0-1,3-4", "items=0-1"])
    expect((await get(undefined, { range })).status).toBe(200);
  expect((await get(undefined, { range: "bytes=0-1", "if-range": "anything" })).status).toBe(200);
});
it("hides inaccessible files and refuses traversal and symlink escapes", async () => {
  for (const name of ["../secret", "escape.bin", ".git/config"])
    expect((await get(`path=${encodeURIComponent(name)}`)).status).toBe(404);
  for (const user of ["carol", "bob"] as const)
    expect(
      (await api.request(user, "GET", `/api/worktrees/${worktree}/raw?path=data.bin`)).status,
    ).toBe(404);
  expect(
    (await api.request(null, "GET", `/api/worktrees/${worktree}/raw?path=data.bin`)).status,
  ).toBe(401);
  expect(
    (
      await api.request(
        "alice",
        "GET",
        `/api/worktrees/${ids("private-carol").worktree}/raw?path=data.bin`,
      )
    ).status,
  ).toBe(404);
  const shared = await api.request(
    "carol",
    "GET",
    `/api/worktrees/${ids("shared-a").worktree}/raw?path=data.bin`,
  );
  expect(shared.status).toBe(200);
  expect(new Uint8Array(await shared.arrayBuffer())).toEqual(bytes);
});
it("refuses a known checkpoint with typed 409 and hides unknown or foreign checkpoints", async () => {
  const known = await get("path=data.bin&at=checkpoint-raw");
  expect(known.status).toBe(409);
  expect(await known.json()).toMatchObject({ _tag: "RawFileUnavailable", mode: "checkpoint" });
  expect((await get("path=data.bin&at=unknown")).status).toBe(404);
  expect((await get("path=data.bin&at=checkpoint-foreign")).status).toBe(404);
});
it("refuses captured reads immediately with typed 409 without preparing a capture", async () => {
  const captured = await createTenancyApi({}, { sessionStore: "captured" });
  try {
    const response = await captured.request(
      "alice",
      "GET",
      `/api/worktrees/${worktree}/raw?path=data.bin`,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ _tag: "RawFileUnavailable", mode: "captured" });
    expect(captured.world.calls.filter((call) => call.startsWith("reads."))).toEqual([]);
  } finally {
    await captured.dispose();
  }
});

it("does not log or trace raw paths, even when query decoding fails", async () => {
  const logs: string[] = [];
  const spans: Tracer.Span[] = [];
  const logged = await createTenancyApi({}, { logs, spans, sessionStore: "colocated" });
  try {
    await logged.request(
      "alice",
      "GET",
      `/api/worktrees/${worktree}/raw?path=private-file-needle.png`,
    );
    await logged.request(
      "alice",
      "HEAD",
      `/api/worktrees/${worktree}/raw?within=private-directory-needle`,
    );
    await logged.request("alice", "GET", "/api/projects");
    expect(logs.some((line) => line.includes("Sent HTTP response"))).toBe(true);
    expect(spans.length).toBeGreaterThan(0);
    const traces = JSON.stringify(spans.map((span) => [span.name, [...span.attributes]]));
    expect(traces).not.toContain("private-file-needle");
    expect(traces).not.toContain("private-directory-needle");
    expect(traces).not.toContain("/raw");
    expect(
      logs.filter(
        (line) =>
          line.includes("private-file-needle") ||
          line.includes("private-directory-needle") ||
          line.includes("/raw"),
      ),
    ).toEqual([]);
  } finally {
    await logged.dispose();
  }
});
