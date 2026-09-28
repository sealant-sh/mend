import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { BlobStoreFsLive } from "../src/blob-store.ts";
import {
  type BulkSectionReady,
  bulkSectionFor,
  bulkSectionsByPlatform,
  type CaptureSections,
  captureKeys,
  decodeManifest,
  keysNeededBy,
  sameBulkSection,
} from "../src/captures.ts";
import { buildManifest, sectionOf, snapshotDirectory, uploadObjects } from "./capture-fixture.ts";

/**
 * `sections.other_bulk` (sealantd PR #101): the bulk sections captured on other platforms,
 * keyed by `<os>-<arch>-<libc>`. Absent when empty, so every manifest before it decodes and
 * encodes exactly as it did; present, each entry decodes like a bulk section.
 */

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const X86 = "linux-x86_64-gnu";
const ARM = "linux-aarch64-gnu";
const hex = (label: string) => label.padEnd(64, "0");

const section = (platform: string, label: string): BulkSectionReady => ({
  root: `captures/wt/1/trees/${hex(label)}`,
  packs: [`captures/wt/1/packs/${hex(`${label}1`)}`],
  platform,
});

const sectionsWith = (
  bulk: CaptureSections["bulk"],
  otherBulk?: CaptureSections["other_bulk"],
): CaptureSections => ({
  git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "unverified" },
  workspace: { root: "", packs: [] },
  bulk,
  ...(otherBulk === undefined ? {} : { other_bulk: otherBulk }),
});

describe("other_bulk in a manifest", () => {
  it("a manifest without other_bulk decodes without the key and encodes byte for byte as before", async () => {
    // sealantd's own pre-#101 bytes (`manifest.rs` `old_bytes`), a format-1 bulk section.
    const old = `{"worktree_id":"wt","n":0,"parent":null,"epoch":1,"seq":0,"kind":"auto","created_at":"x","sections":{"git":{"packs":[],"refs":{},"head":"refs/heads/main","fsck":"verified"},"workspace":{"root":"captures/wt/1/trees/t","packs":[]},"bulk":{"root":"captures/wt/1/trees/b","packs":[],"platform":"p"}}}`;
    const decoded = await Effect.runPromise(decodeManifest("m", utf8(old)));
    expect("other_bulk" in decoded.sections).toBe(false);
    expect(JSON.stringify(decoded)).toBe(old);
    // And what Mend writes itself (capture 0, a standby's base plan) names no other_bulk.
    const written = buildManifest({ worktreeId: "wt", n: 0, parent: null, epoch: 1 });
    expect(Buffer.from(written.bytes).toString("utf8")).not.toContain("other_bulk");
  });

  it("decodes each entry like a bulk section and refuses a format it does not read", async () => {
    const carried = {
      ...section(ARM, "arm"),
      format: 2,
      dir_packs: [`captures/wt/1/packs/${hex("d")}`],
    };
    const manifest = {
      ...buildManifest({
        worktreeId: "wt",
        n: 1,
        parent: hex("p"),
        epoch: 2,
        bulk: section(X86, "x86"),
      }).manifest,
    };
    const withOther = {
      ...manifest,
      sections: {
        ...manifest.sections,
        bulk: { ...section(X86, "x86"), format: 2, dir_packs: [`captures/wt/1/packs/${hex("e")}`] },
        other_bulk: { [ARM]: carried },
      },
    };
    const decoded = await Effect.runPromise(decodeManifest("m", utf8(JSON.stringify(withOther))));
    expect(decoded.sections.other_bulk).toEqual({ [ARM]: carried });
    const unreadable = {
      ...manifest,
      sections: { ...manifest.sections, other_bulk: { [ARM]: { ...carried, format: 3 } } },
    };
    const refused = await Effect.runPromise(
      decodeManifest("m", utf8(JSON.stringify(unreadable))).pipe(
        Effect.map(() => "decoded"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      ),
    );
    expect(refused).toBe("CaptureFormatError");
    const noPlatform = {
      ...manifest,
      sections: { ...manifest.sections, other_bulk: { [ARM]: { root: "r", packs: [] } } },
    };
    const refusedToo = await Effect.runPromise(
      decodeManifest("m", utf8(JSON.stringify(noPlatform))).pipe(
        Effect.map(() => "decoded"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      ),
    );
    expect(refusedToo).toBe("CaptureFormatError");
  });

  it("answers an executor its own platform's tree: bulk, else other_bulk, else pending — never another platform's", () => {
    const x86 = section(X86, "x86");
    const arm = section(ARM, "arm");
    // Same platform: the head's bulk.
    expect(bulkSectionFor(sectionsWith(x86, { [ARM]: arm }), X86)).toEqual(x86);
    // The head's bulk was built elsewhere; other_bulk carries this platform's.
    expect(bulkSectionFor(sectionsWith(x86, { [ARM]: arm }), ARM)).toEqual(arm);
    // A head whose bulk is still pending here, carrying another platform's.
    expect(bulkSectionFor(sectionsWith("pending", { [X86]: x86 }), X86)).toEqual(x86);
    // Nothing for this platform: pending, never x86's.
    expect(bulkSectionFor(sectionsWith(x86), ARM)).toBe("pending");
    expect(bulkSectionFor(sectionsWith(x86, { [ARM]: arm }), "linux-riscv64-gnu")).toBe("pending");
    // An entry keyed for one platform and stamped for another is nobody's.
    expect(bulkSectionFor(sectionsWith("pending", { [ARM]: x86 }), ARM)).toBe("pending");
    expect(bulkSectionFor(sectionsWith("pending", { [ARM]: x86 }), X86)).toBe("pending");
    // bulk wins over an other_bulk entry of its own platform (sealantd `bulk_by_platform`).
    const stale = section(X86, "stale");
    expect(bulkSectionFor(sectionsWith(x86, { [X86]: stale }), X86)).toEqual(x86);
    expect(
      [...bulkSectionsByPlatform(sectionsWith(x86, { [ARM]: arm })).keys()].toSorted(),
    ).toEqual([ARM, X86].toSorted());
  });

  it("names the same tree only for the same platform, root, format, packs and dir packs", () => {
    const x86 = section(X86, "x86");
    expect(sameBulkSection(x86, { ...x86 })).toBe(true);
    expect(sameBulkSection(x86, { ...x86, format: 1 })).toBe(true);
    expect(sameBulkSection(x86, { ...x86, platform: ARM })).toBe(false);
    expect(sameBulkSection(x86, { ...x86, packs: [] })).toBe(false);
    expect(sameBulkSection(x86, { ...x86, root: section(X86, "other").root })).toBe(false);
    expect(
      sameBulkSection(
        { ...x86, format: 2, dir_packs: ["a"] },
        { ...x86, format: 2, dir_packs: ["b"] },
      ),
    ).toBe(false);
  });

  describe("keysNeededBy", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-other-bulk-"));
    afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

    it("presigns the bulk section a plan answers, not the ones other_bulk carries", async () => {
      const keys = captureKeys("wt", 1);
      const tree = (name: string) => {
        const dir = path.join(scratch, name);
        fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
        fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), `${name};\n`);
        return snapshotDirectory(dir, keys, { chunkSize: 64 });
      };
      const own = tree("own");
      const other = tree("other");
      const built = buildManifest({
        worktreeId: "wt",
        n: 1,
        parent: hex("p"),
        epoch: 1,
        bulk: { ...sectionOf(own), platform: X86 },
        otherBulk: { [ARM]: { ...sectionOf(other), platform: ARM } },
      });
      const needed = await Effect.runPromise(
        Effect.gen(function* () {
          yield* uploadObjects(new Map([...own.objects, ...other.objects]));
          return yield* keysNeededBy(built.manifest);
        }).pipe(Effect.provide(BlobStoreFsLive(path.join(scratch, "blobs")))),
      );
      expect(needed).toEqual(expect.arrayContaining([...own.packs, own.root]));
      for (const key of [...other.packs, other.root]) expect(needed).not.toContain(key);
    });
  });
});
