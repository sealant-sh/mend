import { copyFile, mkdir, mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Keep the pilot's native conversation out of Mend's parent transcript harvest. */
export async function preparePilotHome(harness, source = process.env) {
  const root = await mkdtemp(join(tmpdir(), "mend-desktop-pilot-"));
  const target = join(root, harness);
  await mkdir(target, { mode: 0o700 });
  const filename = harness === "codex" ? "auth.json" : ".credentials.json";
  const original =
    harness === "codex"
      ? source.CODEX_HOME || join(source.HOME, ".codex")
      : source.CLAUDE_CONFIG_DIR || join(source.HOME, ".claude");
  try {
    await copyFile(join(original, filename), join(target, filename));
    await chmod(join(target, filename), 0o600);
    return {
      env:
        harness === "codex"
          ? { CODEX_HOME: target, CODEX_SQLITE_HOME: join(target, "db") }
          : { CLAUDE_CONFIG_DIR: target },
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`Connect ${harness} before starting its desktop pilot`, { cause });
  }
}
