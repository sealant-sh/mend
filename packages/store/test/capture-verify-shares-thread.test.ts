import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";

import { BlobStoreFsLive } from "../src/blob-store.ts";
import {
  type CaptureManifest,
  type DirEntry,
  type WorkspaceSection,
  type WorktreeMetaDocument,
  captureKeys,
  crossLinksProblem,
  encodeDirObject,
  FORMAT_DIR_PACKS,
  inodeMetadataProblem,
  sha256Hex,
  verifyPackPayloads,
  withCaptureReadPass,
} from "../src/captures.ts";
import { uploadObjects, writeCdcPack } from "./capture-fixture.ts";

/**
 * Alpha, Mend 0.34.2: a seal's checks over a 1.57 GB capture (a pnpm `node_modules`, ~21,000
 * dir objects) held the API's one thread at 100% CPU for 10+ minutes, and login, `/projects`,
 * attach and Slack each waited 6–10 minutes. Every member a link names was looked up from its
 * class root, and every lookup decompressed, hashed and decoded each dir on its path again — a
 * `.pnpm` of a thousand entries once per member — in batches that never gave the event loop a
 * turn; whole packs were hashed in one call. The same checks, over a smaller tree of the same
 * shape, must leave an HTTP request that arrives meanwhile answered promptly.
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-shares-thread-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const GROUPS = 5;
const DIRS_PER_GROUP = 1_000;
const FILES_PER_DIR = 4;

const dirEntry = (name: string, child: string): DirEntry => ({
  name,
  kind: "dir",
  mode: 0o40755,
  size: 0,
  mtime: 1,
  child,
});

/** `node_modules/.pnpm`-shaped: GROUPS dirs of a thousand packages, each a few small files. */
const buildTree = (keys: ReturnType<typeof captureKeys>) => {
  const objects = new Map<string, Uint8Array>();
  const chunks: Array<Uint8Array> = [];
  const dirObjects: Array<Uint8Array> = [];
  const members: Array<string> = [];
  const dirOf = (entries: ReadonlyArray<DirEntry>) => {
    const bytes = encodeDirObject(entries);
    dirObjects.push(bytes);
    return sha256Hex(bytes);
  };
  const groups: Array<DirEntry> = [];
  for (let group = 0; group < GROUPS; group += 1) {
    const packages: Array<DirEntry> = [];
    for (let at = 0; at < DIRS_PER_GROUP; at += 1) {
      const files: Array<DirEntry> = [];
      for (let file = 0; file < FILES_PER_DIR; file += 1) {
        const bytes = new Uint8Array(
          Buffer.concat([crypto.randomBytes(512), Buffer.alloc(1536, file)]),
        );
        chunks.push(bytes);
        files.push({
          name: `f${file}.js`,
          kind: "file",
          mode: 0o100644,
          size: bytes.byteLength,
          mtime: 1,
          chunks: [sha256Hex(bytes)],
        });
      }
      const name = `pkg${String(at).padStart(4, "0")}`;
      members.push(`g${group}/${name}/f0.js`);
      packages.push(dirEntry(name, dirOf(files)));
    }
    groups.push(dirEntry(`g${group}`, dirOf(packages)));
  }
  const root = dirOf(groups);
  const pack = (parts: ReadonlyArray<Uint8Array>) => {
    const written = writeCdcPack(parts);
    const key = keys.pack(sha256Hex(written.bytes));
    objects.set(key, written.bytes);
    return key;
  };
  const packs: Array<string> = [];
  for (let at = 0; at < chunks.length; at += 4_000) packs.push(pack(chunks.slice(at, at + 4_000)));
  // One pack at sealantd's largest (`MAX_PACK_BYTES`, 64 MiB), of 1 MiB chunks.
  const half = 1 << 19;
  packs.push(
    pack(
      Array.from(
        { length: 64 },
        (_, at) =>
          new Uint8Array(Buffer.concat([crypto.randomBytes(half), Buffer.alloc(half, at)])),
      ),
    ),
  );
  const section: WorkspaceSection = {
    root,
    packs,
    format: FORMAT_DIR_PACKS,
    dir_packs: [pack(dirObjects)],
  };
  return { objects, section, members };
};

/** A local HTTP server whose handler runs an Effect, as the API's do, and a client timing it. */
const makeProbe = async () => {
  const server = http.createServer((_request, response) => {
    void Effect.runPromise(Effect.succeed("ok").pipe(Effect.delay(0))).then((body) =>
      response.end(body),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const request = () => fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  // The first request loads `fetch` itself and opens the connection, none of it the checks'
  // doing: it is answered before any request is timed.
  await request();
  const latencies: Array<number> = [];
  const probing = { running: true };
  const loop = (async () => {
    while (probing.running) {
      const started = performance.now();
      await request();
      latencies.push(performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    stop: async () => {
      probing.running = false;
      await loop;
      await new Promise((resolve) => server.close(resolve));
      return latencies;
    },
  };
};

it(
  "a seal's store checks over a node_modules-shaped capture leave other requests answered promptly",
  { timeout: 300_000 },
  async () => {
    const keys = captureKeys("wt-shares-thread", 1);
    const { objects, section, members } = buildTree(keys);
    const layer = BlobStoreFsLive(path.join(scratch, "blobs"));
    await Effect.runPromise(uploadObjects(objects).pipe(Effect.provide(layer)));
    const manifest: CaptureManifest = {
      worktree_id: "wt-shares-thread",
      n: 1,
      parent: null,
      epoch: 1,
      seq: 0,
      kind: "final",
      created_at: new Date().toISOString(),
      sections: {
        git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "unverified" },
        workspace: section,
        bulk: { ...section, platform: "linux-x86_64-glibc" },
      },
    };
    // pnpm's store in the workspace class, hardlinked into `node_modules` (the bulk class).
    const document: WorktreeMetaDocument = {
      format: 1,
      entries: [],
      cross_links: members.map((member) => [
        { class: "workspace", member },
        { class: "bulk", member },
      ]),
    };
    // What `sealChecks` (`@mend/sessions`) runs over the store, in one pass.
    const checks = withCaptureReadPass(
      Effect.gen(function* () {
        const payloads = yield* verifyPackPayloads(section.packs);
        const crossLinks = yield* crossLinksProblem(manifest, document);
        const inodes = yield* inodeMetadataProblem(manifest, document);
        return { payloads, crossLinks, inodes };
      }),
    ).pipe(Effect.provide(layer));

    const probe = await makeProbe();
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    // The histogram never records its first interval, and the checks' first synchronous stretch
    // would be it: one interval passes before they start.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const started = performance.now();
    const outcome = await Effect.runPromise(checks);
    const ms = performance.now() - started;
    delay.disable();
    const latencies = await probe.stop();

    expect(outcome.crossLinks).toBeNull();
    expect(outcome.inodes).toBeNull();
    expect(outcome.payloads.packs).toBe(section.packs.length);
    const worstRequest = Math.max(...latencies);
    const worstDelay = delay.max / 1e6;
    console.log(
      `seal checks ${Math.round(ms)} ms over ${members.length} links · ${latencies.length} requests, worst ${Math.round(worstRequest)} ms · event-loop delay max ${Math.round(worstDelay)} ms, p99 ${Math.round(delay.percentile(99) / 1e6)} ms`,
    );
    // Requests kept arriving, and were answered, while the checks ran.
    expect(latencies.length).toBeGreaterThan(10);
    // No stall takes half the checks' own run, timed here on this machine, so the bound scales
    // with the runner where a fixed one did not (CI runs the checks in 4–7 s, a laptop in 0.6 s).
    // Checks that hold the thread through their work stall for nearly all of it, as alpha's did
    // for minutes. These stall longest at their start, while the file store reads the first packs
    // synchronously: ~11% of the run on a laptop, up to a quarter on CI.
    expect(worstRequest).toBeLessThan(ms / 2);
    expect(worstDelay).toBeLessThan(ms / 2);
  },
);
