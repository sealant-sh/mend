import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { runExec, startPickupChannel } from "../test/pickup-channel.ts";
import { writeFilesPickupExec } from "./workspace-files.ts";
import { writeWorktreeFileOnHost } from "./worktree-file-write.ts";

describe.each(["host", "captured"] as const)("%s worktree file writes", (mode) => {
  it("creates parents, replaces files and preserves executable modes without exposing contents in argv", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-worktree-write-"));
    const channel = await startPickupChannel();
    const contents = "#!/bin/sh\n# private plan\necho done\n";
    const write = async (relative: string) => {
      if (mode === "host")
        return Effect.runPromise(writeWorktreeFileOnHost(root, relative, contents));
      const file = { path: path.join(root, relative), bytes: new TextEncoder().encode(contents) };
      const argv = writeFilesPickupExec(
        [{ path: file.path, replaceWithin: root }],
        channel.mint([file]),
      );
      expect(argv.join("\0")).not.toContain(contents);
      const result = await runExec(argv, channel.env);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    };
    try {
      await write("docs/plan.md");
      expect(fs.readFileSync(path.join(root, "docs/plan.md"), "utf8")).toBe(contents);
      fs.chmodSync(path.join(root, "docs/plan.md"), 0o755);
      await write("docs/plan.md");
      expect(fs.statSync(path.join(root, "docs/plan.md")).mode & 0o777).toBe(0o755);
      fs.symlinkSync("docs", path.join(root, "notes"));
      fs.symlinkSync("docs/plan.md", path.join(root, "plan.md"));
      await write("notes/linked.md");
      await write("plan.md");
      expect(fs.readFileSync(path.join(root, "docs/linked.md"), "utf8")).toBe(contents);
      expect(fs.lstatSync(path.join(root, "plan.md")).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(path.join(root, "docs")).toSorted()).toEqual(["linked.md", "plan.md"]);
    } finally {
      await channel.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses linked files and directories and leaves outside bytes intact", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-worktree-write-"));
    const root = path.join(scratch, "repo");
    fs.mkdirSync(root);
    const outside = path.join(scratch, "outside.txt");
    fs.writeFileSync(outside, "keep me");
    fs.symlinkSync(outside, path.join(root, "linked.txt"));
    fs.symlinkSync(scratch, path.join(root, "linked-dir"));
    const channel = await startPickupChannel();
    try {
      for (const relative of ["linked.txt", "linked-dir/outside.txt", ".git/config"]) {
        if (mode === "host") {
          const result = await Effect.runPromise(
            Effect.result(writeWorktreeFileOnHost(root, relative, "replace")),
          );
          expect(result._tag).toBe("Failure");
        } else {
          const file = {
            path: path.join(root, relative),
            bytes: new TextEncoder().encode("replace"),
          };
          const result = await runExec(
            writeFilesPickupExec([{ path: file.path, replaceWithin: root }], channel.mint([file])),
            channel.env,
          );
          expect(result.status).not.toBe(0);
        }
      }
      expect(fs.readFileSync(outside, "utf8")).toBe("keep me");
    } finally {
      await channel.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
