import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { nativeSeedProbeArgv } from "../src/native-fork-seed.ts";
import { writeFilesPickupExec } from "../src/workspace-files.ts";
import { runExec, startPickupChannel } from "./pickup-channel.ts";

describe("retained native seed delivery", () => {
  it("delivers missing files exclusively, verifies retries and refuses changed bytes or links", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-native-seed-"));
    const channel = await startPickupChannel();
    const root = path.join(tmp, "child");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const relativePath = ".claude/projects/repo/retained.jsonl";
    const target = path.join(root, relativePath);
    const bytes = new TextEncoder().encode("retained history\n");
    const files = [
      {
        relativePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
      },
    ];
    const probe = () => {
      const [command, ...args] = nativeSeedProbeArgv(root, files);
      if (command === undefined) throw new Error("probe command missing");
      return JSON.parse(execFileSync(command, args, { encoding: "utf8", stdio: "pipe" }));
    };
    try {
      expect(probe()).toEqual([relativePath]);
      const ticket = channel.mint([{ path: target, bytes }]);
      const delivered = await runExec(
        writeFilesPickupExec(
          [{ path: target, within: { root, directoryMode: 0o700, fileMode: 0o600 } }],
          ticket,
        ),
        channel.env,
      );
      expect(delivered.status).toBe(0);
      expect(probe()).toEqual([]);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      fs.writeFileSync(target, "changed native history\n");
      expect(probe).toThrow();
      expect(fs.readFileSync(target, "utf8")).toBe("changed native history\n");
      fs.renameSync(path.join(root, ".claude"), path.join(tmp, "kept"));
      fs.symlinkSync(outside, path.join(root, ".claude"));
      expect(probe).toThrow();
      const linkedTicket = channel.mint([{ path: target, bytes }]);
      const linked = await runExec(
        writeFilesPickupExec(
          [{ path: target, within: { root, directoryMode: 0o700, fileMode: 0o600 } }],
          linkedTicket,
        ),
        channel.env,
      );
      expect(linked.status).not.toBe(0);
      expect(fs.readdirSync(outside)).toEqual([]);
      const linkedRoot = path.join(tmp, "linked-root");
      fs.symlinkSync(outside, linkedRoot);
      const [command, ...args] = nativeSeedProbeArgv(linkedRoot, files);
      expect(() => execFileSync(command ?? "node", args, { stdio: "pipe" })).toThrow();
    } finally {
      await channel.close();
      fs.readdirSync(tmp);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
