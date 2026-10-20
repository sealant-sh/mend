import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** How long a toast's claim holds: a wait or finish older than this toasts nowhere. */
export const TOAST_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const exists = (cause: unknown): boolean =>
  cause instanceof Error && Reflect.get(cause, "code") === "EEXIST";

/** A claim's file name: when its wait began, then its key. */
const CLAIM_NAME = /^(\d+)\./;

/**
 * Which window of this VS Code toasts a notification: the first to claim its key. Each window
 * reads Mend on its own and checks focus when its read lands, so two windows can each be focused
 * at their own moment for the same wait (rule 12: one question, one toast). A claim is a file
 * created only if absent, in the extension's global storage that every window shares.
 *
 * A key names one wait (its session, kind and start, or its request) and never comes back for a
 * later one. Its file is named by when the wait began, so whether it expired is a fact of the
 * name: no window claims a wait past the expiry, and the sweep removes only names past it. No
 * window can therefore remove a claim another could still make or have made.
 */
export class ToastClaims {
  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * True for the one window that claims `key` first. False past the expiry, and when `at` is no
   * time. True when the claim cannot be made: a toast twice beats none when storage fails.
   */
  async claim(key: string, at: string): Promise<boolean> {
    const began = Date.parse(at);
    if (!this.#fresh(began)) return false;
    try {
      await mkdir(this.directory, { recursive: true });
      await this.#sweep();
      await writeFile(this.#path(key, began), "", { flag: "wx" });
    } catch (cause) {
      return !exists(cause);
    }
    // Made past the expiry, the file may be one a sweep removed from an earlier claim's place.
    return this.#fresh(began);
  }

  /**
   * Gives `key` back: this window will not show it after all, or its wait ended. Another window
   * may then claim it.
   */
  async release(key: string, at: string): Promise<void> {
    const began = Date.parse(at);
    if (Number.isNaN(began)) return;
    await rm(this.#path(key, began), { force: true }).catch(() => undefined);
  }

  #fresh(began: number): boolean {
    return !Number.isNaN(began) && this.now() - began < TOAST_CLAIM_TTL_MS;
  }

  #path(key: string, began: number): string {
    return join(this.directory, `${began}.${encodeURIComponent(key)}`);
  }

  async #sweep(): Promise<void> {
    const names = await readdir(this.directory).catch(() => []);
    await Promise.all(
      names.map(async (name) => {
        const began = CLAIM_NAME.exec(name)?.[1];
        if (began !== undefined && !this.#fresh(Number(began)))
          await rm(join(this.directory, name), { force: true });
      }),
    );
  }
}
