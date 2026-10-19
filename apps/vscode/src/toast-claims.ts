import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Past this, a claim's wait or finish is long over: its file goes. */
export const TOAST_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

const exists = (cause: unknown): boolean =>
  cause instanceof Error && Reflect.get(cause, "code") === "EEXIST";

/**
 * Which window of this VS Code toasts a notification: the first to claim its key. Each window
 * reads Mend on its own and checks focus when its read lands, so two windows can each be focused
 * at their own moment for the same wait (rule 12: one question, one toast). A claim is a file
 * created only if absent, in the extension's global storage that every window shares.
 */
export class ToastClaims {
  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** True for the one window that claims `key` first; when the claim cannot be made, true too. */
  async claim(key: string): Promise<boolean> {
    try {
      await mkdir(this.directory, { recursive: true });
      await this.#sweep();
      await writeFile(join(this.directory, encodeURIComponent(key)), "", { flag: "wx" });
      return true;
    } catch (cause) {
      return !exists(cause);
    }
  }

  async #sweep(): Promise<void> {
    const names = await readdir(this.directory).catch(() => []);
    await Promise.all(
      names.map(async (name) => {
        const path = join(this.directory, name);
        const made = await stat(path).then(
          (found) => found.mtimeMs,
          () => null,
        );
        if (made !== null && this.now() - made >= TOAST_CLAIM_TTL_MS)
          await rm(path, { force: true });
      }),
    );
  }
}
