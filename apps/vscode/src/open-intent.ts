import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** As long as an open may take: an intent no window took by then names no open in flight. */
export const OPEN_INTENT_TTL_MS = 10 * 60 * 1000;

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && Reflect.get(cause, "code") === "ENOENT";

/**
 * Which session an Open meant, carried to the window it opens. A worktree's workspace can hold
 * several sessions, and the folder a window opens names only the workspace, so the opening window
 * leaves the session in a file per workspace, and the workspace window takes it when it starts or
 * gains focus. The files sit in the extension's global storage, outside any one window, so they
 * survive the window reloading into the workspace.
 *
 * One file per workspace, each written whole by a rename and taken by a rename, keeps windows from
 * losing each other's intents or bringing back one already taken. The extension's `globalState`
 * cannot: each window writes the whole state from its own cached copy. The folder's URI cannot
 * carry the session either: it is the workspace's identity to VS Code (its recent entry and its
 * saved editor state), and its authority is the gateway user and the one Host alias.
 */
export class OpenIntents {
  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}

  async write(intent: { readonly workspaceId: string; readonly sessionId: string }): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = this.#file(intent.workspaceId);
    const written = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(written, JSON.stringify({ sessionId: intent.sessionId, at: this.now() }));
      await rename(written, file);
    } catch (cause) {
      await rm(written, { force: true });
      throw cause;
    }
  }

  /** The session the latest open into this workspace meant, once; null when none is fresh. */
  async take(workspaceId: string): Promise<string | null> {
    await this.#sweep();
    const file = this.#file(workspaceId);
    const taken = `${file}.${randomUUID()}.taken`;
    try {
      await rename(file, taken);
    } catch (cause) {
      if (isMissing(cause)) return null;
      throw cause;
    }
    try {
      const value: unknown = JSON.parse(await readFile(taken, "utf8"));
      if (typeof value !== "object" || value === null) return null;
      const sessionId: unknown = Reflect.get(value, "sessionId");
      const at: unknown = Reflect.get(value, "at");
      return typeof sessionId === "string" &&
        typeof at === "number" &&
        this.now() - at < OPEN_INTENT_TTL_MS
        ? sessionId
        : null;
    } finally {
      await rm(taken, { force: true });
    }
  }

  /**
   * What a crash left behind: a `.tmp` a write never renamed, a `.taken` a take never removed.
   * Each is past use once older than the expiry, so it goes; a newer one may belong to an open in
   * flight and stays. Best effort. An intent nobody took stays for its workspace's next take,
   * which refuses it as stale: another window may rename a fresh intent onto that name between
   * any look at it here and its removal.
   */
  async #sweep(): Promise<void> {
    const names = await readdir(this.directory).catch(() => []);
    await Promise.all(
      names
        .filter((name) => /\.(tmp|taken)$/.test(name))
        .map(async (name) => {
          const path = join(this.directory, name);
          const changed = await stat(path).then(
            (found) => found.mtimeMs,
            () => null,
          );
          if (changed !== null && this.now() - changed >= OPEN_INTENT_TTL_MS)
            await rm(path, { force: true });
        }),
    );
  }

  #file(workspaceId: string): string {
    return join(this.directory, `${encodeURIComponent(workspaceId)}.json`);
  }
}
