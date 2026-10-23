import { randomUUID } from "node:crypto";

import type { KeptReviews, SharedRecord } from "./kept-reviews.js";

/**
 * The key that pins each change's slice, per server URL, so a reload and every window show the
 * same slice: `reviews/open` answers the same slice for the same key. Kept in a file every window
 * shares (`kept-reviews.ts`), so two windows reading a change first agree on one key.
 */

/** A pin unused this long goes: the next read of its change pins the worktree as it is then. */
export const PIN_UNUSED_MS = 90 * 24 * 60 * 60 * 1000;
/** How often a read of a change marks its pin used, so reading it writes at most once a day. */
const PIN_USED_EVERY_MS = 24 * 60 * 60 * 1000;

export interface Pin {
  readonly key: string;
  /** When a read last used it, in ms. */
  readonly usedAt: number;
}

/** One server's pins, by change id. */
export type Pins = Readonly<Record<string, Pin>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A server's pins as stored; a pin that does not read back is not kept. */
export const parsePins = (value: unknown): Pins =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([changeId, pin]) => {
          if (!isRecord(pin)) return [];
          const { key, usedAt } = pin;
          return typeof key === "string" && typeof usedAt === "number"
            ? [[changeId, { key, usedAt }]]
            : [];
        }),
      )
    : {};

export const newOpenKey = (changeId: string): string => `vscode-review:${changeId}:${randomUUID()}`;

const pinsOf = (serverUrl: string): SharedRecord<Pins> => ({
  name: `pins/${encodeURIComponent(serverUrl)}.json`,
  what: "the slices this VS Code pinned for review",
  format: 1,
  parse: parsePins,
});

export class ReviewMemory {
  /** Keys this window could not keep, by server and change: it reads with the same one. */
  readonly #unkept = new Map<string, string>();

  constructor(
    private readonly kept: Pick<KeptReviews, "readRecord" | "updateRecord">,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The key pinning this change's slice, made and kept the first time it is asked for. A read
   * takes the pins' lock only to make a pin or mark it used; a pin it cannot keep is used as read.
   */
  async pinKey(serverUrl: string, changeId: string): Promise<string> {
    const read = await this.kept.readRecord(pinsOf(serverUrl)).catch((): Pins => ({}));
    const found = read[changeId];
    if (found !== undefined && this.now() - found.usedAt < PIN_USED_EVERY_MS) return found.key;
    const unkept = `${serverUrl} ${changeId}`;
    try {
      return await this.#pin(serverUrl, changeId, (kept, now) =>
        kept !== undefined && now - kept.usedAt < PIN_USED_EVERY_MS
          ? kept
          : { key: kept?.key ?? this.#unkept.get(unkept) ?? newOpenKey(changeId), usedAt: now },
      );
    } catch {
      if (found !== undefined) return found.key;
      const key = this.#unkept.get(unkept) ?? newOpenKey(changeId);
      this.#unkept.set(unkept, key);
      return key;
    }
  }

  /** A new key for this change: the next `reviews/open` pins a slice of the worktree as it is now. */
  async repin(serverUrl: string, changeId: string): Promise<string> {
    return this.#pin(serverUrl, changeId, (_found, now) => ({
      key: newOpenKey(changeId),
      usedAt: now,
    }));
  }

  /** Sets the change's pin under the pins' lock, and drops each one unused past the expiry. */
  async #pin(
    serverUrl: string,
    changeId: string,
    choose: (found: Pin | undefined, now: number) => Pin,
  ): Promise<string> {
    const now = this.now();
    const pins = await this.kept.updateRecord(pinsOf(serverUrl), (kept) => {
      const found = kept[changeId];
      const pin = choose(found, now);
      if (pin === found) return kept;
      return {
        ...Object.fromEntries(
          Object.entries(kept).filter(([, other]) => now - other.usedAt < PIN_UNUSED_MS),
        ),
        [changeId]: pin,
      };
    });
    const pin = pins[changeId];
    if (pin === undefined) throw new Error("VS Code did not keep the key pinning this change.");
    return pin.key;
  }
}
