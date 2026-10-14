import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  HarnessStateInvalidError,
  HarnessStateNotFoundError,
  locateHarnessState,
  readHarnessStateManifest,
} from "@mend/sessions";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

const withStateDir = async <A>(run: (stateDir: string) => Promise<A>): Promise<A> => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-harness-state-test-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
};

describe("readHarnessStateManifest", () => {
  it("reads a valid saved-state manifest", async () => {
    await withStateDir(async (stateDir) => {
      await fs.writeFile(
        path.join(stateDir, "manifest.json"),
        JSON.stringify({
          harness: "codex",
          providerSessionId: "01989f08-224f-7a83-a617-d511dc2c2cbd",
          capturedAt: "2026-08-10T12:00:00.000Z",
        }),
      );

      const manifest = await Effect.runPromise(readHarnessStateManifest(stateDir, "session-1"));

      expect(manifest.harness).toBe("codex");
      expect(manifest.providerSessionId).toBe("01989f08-224f-7a83-a617-d511dc2c2cbd");
    });
  });

  it("tags a missing manifest instead of treating it as a fresh session", async () => {
    await withStateDir(async (stateDir) => {
      const error = await Effect.runPromise(
        readHarnessStateManifest(stateDir, "session-2").pipe(Effect.flip),
      );

      expect(error).toBeInstanceOf(HarnessStateNotFoundError);
      expect(error.message).toContain("session-2");
    });
  });

  it("tags malformed JSON as invalid saved state", async () => {
    await withStateDir(async (stateDir) => {
      await fs.writeFile(path.join(stateDir, "manifest.json"), "{not json");

      const error = await Effect.runPromise(
        readHarnessStateManifest(stateDir, "session-3").pipe(Effect.flip),
      );

      expect(error).toBeInstanceOf(HarnessStateInvalidError);
      expect(error.message).toContain("session-3");
    });
  });

  it("tags a structurally incomplete manifest as invalid saved state", async () => {
    await withStateDir(async (stateDir) => {
      await fs.writeFile(
        path.join(stateDir, "manifest.json"),
        JSON.stringify({ harness: "codex" }),
      );

      const error = await Effect.runPromise(
        readHarnessStateManifest(stateDir, "session-4").pipe(Effect.flip),
      );

      expect(error).toBeInstanceOf(HarnessStateInvalidError);
    });
  });
});

const manifest = (harness: string, providerSessionId: string) =>
  JSON.stringify({ harness, providerSessionId, capturedAt: "2026-08-21T12:00:00.000Z" });

describe("locateHarnessState", () => {
  it("prefers the newest agent process capture over the legacy session-root one", async () => {
    await withStateDir(async (sessionDir) => {
      const older = path.join(sessionDir, "processes", "proc-older");
      const newer = path.join(sessionDir, "processes", "proc-newer");
      await fs.mkdir(older, { recursive: true });
      await fs.mkdir(newer, { recursive: true });
      await fs.writeFile(path.join(sessionDir, "manifest.json"), manifest("codex", "legacy"));
      await fs.writeFile(path.join(older, "manifest.json"), manifest("codex", "older"));
      await fs.writeFile(path.join(newer, "manifest.json"), manifest("claude", "newer"));

      const located = await Effect.runPromise(
        locateHarnessState(sessionDir, [newer, older], "session-1"),
      );
      expect(located.stateDir).toBe(newer);
      expect(located.manifest.harness).toBe("claude");
      expect(located.manifest.providerSessionId).toBe("newer");
    });
  });

  it("skips agent processes that never harvested and falls back to the session root", async () => {
    await withStateDir(async (sessionDir) => {
      const empty = path.join(sessionDir, "processes", "proc-empty");
      const missing = path.join(sessionDir, "processes", "proc-missing");
      await fs.mkdir(empty, { recursive: true });
      await fs.writeFile(path.join(sessionDir, "manifest.json"), manifest("codex", "legacy"));

      const located = await Effect.runPromise(
        locateHarnessState(sessionDir, [empty, missing], "session-1"),
      );
      expect(located.stateDir).toBe(sessionDir);
      expect(located.manifest.providerSessionId).toBe("legacy");
    });
  });

  it("reports not-found against the session root when nothing was ever captured", async () => {
    await withStateDir(async (sessionDir) => {
      const outcome = await Effect.runPromise(
        locateHarnessState(
          sessionDir,
          [path.join(sessionDir, "processes", "proc-1")],
          "session-1",
        ).pipe(Effect.flip),
      );
      expect(outcome).toBeInstanceOf(HarnessStateNotFoundError);
      expect(outcome.path).toBe(path.join(sessionDir, "manifest.json"));
    });
  });
});
