import * as fs from "node:fs";
import { Agent, get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckpointId, SequenceNumber, Sha } from "@mend/domain";
import { Checkpoint } from "@mend/domain/workbench";
import { RawReadError, Store, StoreConfig } from "@mend/store";
import { Duration, Effect, Layer, type Tracer } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const worktree = ids("private-alice").worktree;
let api: TenancyApi;
let root: string;
let store: Store["Service"];
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
beforeAll(async () => {
  root = fs.mkdtempSync(join(tmpdir(), "mend-raw-http-"));
  fs.writeFileSync(join(root, "data.bin"), bytes);
  fs.writeFileSync(join(root, "empty.bin"), "");
  fs.symlinkSync("/etc/passwd", join(root, "escape.bin"));
  store = await Effect.runPromise(
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
      node: true,
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
  expect(response.headers.get("x-mend-file-identity")).toMatch(/^[a-f0-9]{64}$/);
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
    for (const range of [undefined, "bytes=999999-"])
      expect(
        (await get(`path=${encodeURIComponent(name)}`, range === undefined ? {} : { range }))
          .status,
      ).toBe(404);
  expect((await get("path=data.bin&within=docs", { range: "bytes=999999-" })).status).toBe(404);
  // A repeated parameter fails query decoding before the handler runs.
  for (const query of ["path=data.bin&path=empty.bin", "path=data.bin&within=&within=docs"])
    expect((await get(query)).status).toBe(400);
  for (const user of ["carol", "bob"] as const)
    for (const headers of [{}, { range: "bytes=999999-" }])
      expect(
        (
          await api.request(
            user,
            "GET",
            `/api/worktrees/${worktree}/raw?path=data.bin`,
            undefined,
            headers,
          )
        ).status,
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
it("answers the captured layer's refusal as a typed 409", async () => {
  const captured = await createTenancyApi(
    {},
    {
      sessionStore: "captured",
      implement: {
        reads: { openRawFile: () => Effect.fail(new RawReadError({ reason: "captured" })) },
      },
    },
  );
  try {
    const response = await captured.request(
      "alice",
      "GET",
      `/api/worktrees/${worktree}/raw?path=data.bin`,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ _tag: "RawFileUnavailable", mode: "captured" });
  } finally {
    await captured.dispose();
  }
});

it("does not log or trace raw paths, in any spelling the router accepts, even when query decoding fails", async () => {
  const logs: string[] = [];
  const spans: Tracer.Span[] = [];
  fs.writeFileSync(join(root, "private-file-needle.png"), bytes);
  const logged = await createTenancyApi(
    {},
    {
      logs,
      spans,
      sessionStore: "colocated",
      implement: {
        reads: {
          openRawFile: (_project, _worktree, target) =>
            store.openRawWorktreeFile(root, target.path, target.within),
        },
      },
    },
  );
  try {
    for (const route of [
      `/api/worktrees/${worktree}/raw`,
      `/api/worktrees/${worktree}/raw/`,
      `/api//worktrees/${worktree}/raw`,
      `/API/Worktrees/${worktree}/RAW`,
      `/api/worktrees/${worktree}/r%61w`,
    ]) {
      const found = await logged.request("alice", "GET", `${route}?path=private-file-needle.png`);
      expect(found.status, route).toBe(200);
      await found.arrayBuffer();
      const missing = await logged.request(
        "alice",
        "GET",
        `${route}?path=private-file-needle.gif&within=private-directory-needle`,
      );
      expect(missing.status, route).toBe(404);
    }
    // The router ends the path at `;`; the query no longer decodes, but the route still matched.
    const parameter = await logged.request(
      "alice",
      "GET",
      `/api/worktrees/${worktree}/raw;v=1?path=private-file-needle.png`,
    );
    expect(parameter.status).toBe(400);
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
    expect(traces.toLowerCase()).not.toMatch(/\/r(aw|%61w)/);
    expect(
      logs.filter(
        (line) =>
          line.includes("private-file-needle") ||
          line.includes("private-directory-needle") ||
          /\/r(aw|%61w)/i.test(line),
      ),
    ).toEqual([]);
  } finally {
    await logged.dispose();
    fs.rmSync(join(root, "private-file-needle.png"));
  }
});

const descriptors = () => fs.readdirSync("/proc/self/fd").length;

it("streams a large file without holding it, and lets go of it when the reader goes", async () => {
  const large = join(root, "large.bin");
  const size = 1024 * 1024 * 1024;
  fs.writeFileSync(large, "");
  fs.truncateSync(large, size);
  const before = descriptors();
  const memoryBefore = process.memoryUsage().arrayBuffers;
  let peak = 0;
  let total = 0;
  const whole = await get("path=large.bin");
  expect(whole.headers.get("content-length")).toBe(String(size));
  const reader = whole.body?.getReader();
  for (;;) {
    const chunk = await reader?.read();
    if (chunk === undefined || chunk.done) break;
    total += chunk.value.byteLength;
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - memoryBefore);
  }
  expect(total).toBe(size);
  // Bytes in flight, plus what the collector has not caught up with: never the file whole.
  expect(peak).toBeLessThan(size / 4);

  const abandoned = await get("path=large.bin");
  const partial = abandoned.body?.getReader();
  await partial?.read();
  await partial?.cancel();
  for (let attempt = 0; attempt < 50 && descriptors() > before; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(descriptors()).toBe(before);
  fs.rmSync(large);
}, 60_000);

/** What a browser on a keep-alive socket sees of a body: its end, a reset, or no end at all. */
const readOverSocket = (url: string, onFirstChunk: () => void) => {
  // The first of end, reset or hang is the answer; a promise settles once.
  const seen = Promise.withResolvers<{
    status: number;
    length: number;
    received: number;
    outcome: string;
  }>();
  const agent = new Agent({ keepAlive: true });
  let status = 0;
  let length = 0;
  let received = 0;
  const finish = (outcome: string) => {
    clearTimeout(timer);
    request.destroy();
    agent.destroy();
    seen.resolve({ status, length, received, outcome });
  };
  const timer = setTimeout(() => finish("hang"), 3000);
  const request = httpGet(url, { agent, headers: { authorization: "Bearer alice" } }, (res) => {
    status = res.statusCode ?? 0;
    length = Number(res.headers["content-length"]);
    res.on("data", (chunk: Buffer) => {
      if (received === 0) {
        res.pause();
        onFirstChunk();
        setTimeout(() => res.resume(), 50);
      }
      received += chunk.length;
    });
    res.on("end", () => finish("end"));
    res.on("close", () => finish("reset"));
    res.on("error", () => finish("reset"));
  });
  request.on("error", () => finish("reset"));
  return seen.promise;
};

it("resets the socket when the file stops short after the headers went out", async () => {
  const size = 64 * 1024 * 1024;
  const shrinking = join(root, "shrinking.bin");
  fs.writeFileSync(shrinking, "");
  fs.truncateSync(shrinking, size);
  const seen = await readOverSocket(
    `${api.nodeOrigin}/api/worktrees/${worktree}/raw?path=shrinking.bin`,
    () => fs.truncateSync(shrinking, 0),
  );
  expect(seen.status).toBe(200);
  expect(seen.length).toBe(size);
  expect(seen.received).toBeLessThan(size);
  expect(seen.outcome).toBe("reset");
  const whole = await readOverSocket(
    `${api.nodeOrigin}/api/worktrees/${worktree}/raw?path=data.bin`,
    () => undefined,
  );
  expect(whole).toEqual({ status: 200, length: 256, received: 256, outcome: "end" });
  fs.rmSync(shrinking);
});

it("bounds open raw reads per account and in all, and frees a slot when its reader goes", async () => {
  const large = join(root, "slots.bin");
  fs.writeFileSync(large, "");
  fs.truncateSync(large, 64 * 1024 * 1024);
  const bounded = await createTenancyApi(
    { accountRawReads: 2, rawReads: 3 },
    {
      sessionStore: "colocated",
      implement: {
        reads: {
          openRawFile: (_project, _worktree, target) =>
            store.openRawWorktreeFile(root, target.path, target.within),
        },
      },
    },
  );
  const read = (user: "alice" | "carol") =>
    bounded.request(
      user,
      "GET",
      `/api/worktrees/${user === "alice" ? worktree : ids("shared-a").worktree}/raw?path=slots.bin`,
    );
  try {
    const held = [await read("alice"), await read("alice")];
    for (const response of held) expect(response.status).toBe(200);
    const account = await read("alice");
    expect(account.status).toBe(429);
    expect(await account.json()).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "accountRawReads",
      limit: 2,
    });
    const other = await read("carol");
    expect(other.status).toBe(200);
    const instance = await read("carol");
    expect(instance.status).toBe(429);
    expect(await instance.json()).toMatchObject({ budget: "rawReads", limit: 3 });
    await held[0]?.body?.cancel();
    const admitted = await read("alice");
    expect(admitted.status).toBe(200);
    for (const response of [held[1], other, admitted]) await response?.body?.cancel();
  } finally {
    await bounded.dispose();
    fs.rmSync(large);
  }
});

it("resets a reader that stops taking bytes, and frees its slot and descriptor", async () => {
  const large = join(root, "stalled.bin");
  fs.writeFileSync(large, "");
  fs.truncateSync(large, 256 * 1024 * 1024);
  const stalling = await createTenancyApi(
    { accountRawReads: 1 },
    {
      sessionStore: "colocated",
      node: true,
      rawReadStall: Duration.millis(300),
      implement: {
        reads: {
          openRawFile: (_project, _worktree, target) =>
            store.openRawWorktreeFile(root, target.path, target.within),
        },
      },
    },
  );
  try {
    const before = descriptors();
    const first = Promise.withResolvers<void>();
    const agent = new Agent({ keepAlive: true });
    const request = httpGet(
      `${stalling.nodeOrigin}/api/worktrees/${worktree}/raw?path=stalled.bin`,
      { agent, headers: { authorization: "Bearer alice" } },
      (res) => {
        // A paused video: the reader takes one chunk, then nothing, and never closes.
        res.once("data", () => {
          res.pause();
          first.resolve();
        });
      },
    );
    request.on("error", () => undefined);
    await first.promise;
    const head = () =>
      stalling.request("alice", "HEAD", `/api/worktrees/${worktree}/raw?path=data.bin`);
    expect((await head()).status).toBe(429);
    let status = 429;
    for (let attempt = 0; attempt < 60 && status !== 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await head()).status;
    }
    expect(status).toBe(200);
    // The reader's own socket lives in this process too.
    agent.destroy();
    for (let attempt = 0; attempt < 50 && descriptors() > before; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(descriptors()).toBeLessThanOrEqual(before);
  } finally {
    await stalling.dispose();
    fs.rmSync(large);
  }
}, 20_000);
