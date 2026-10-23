import { randomUUID } from "node:crypto";

import { Unwritable, type KeptReviews, type SharedRecord } from "./kept-reviews.js";

export const PIN_UNUSED_MS = 90 * 24 * 60 * 60 * 1000;
const PIN_USED_EVERY_MS = 24 * 60 * 60 * 1000;

export interface Pin {
  readonly key: string;
  readonly usedAt: number;
}

export type Pins = Readonly<Record<string, Pin>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  onUnreadable: "overwrite",
  parse: parsePins,
});

const fresh = (pin: Pin, now: number): boolean => now - pin.usedAt < PIN_USED_EVERY_MS;

export const unkeptKey = (changeId: string): string => `vscode-review:${changeId}:unkept`;

const withoutUnused = (pins: Pins, now: number): Pins =>
  Object.fromEntries(Object.entries(pins).filter(([, pin]) => now - pin.usedAt < PIN_UNUSED_MS));

export class ReviewMemory {
  constructor(
    private readonly kept: Pick<KeptReviews, "readRecord" | "updateRecord">,
    private readonly now: () => number = Date.now,
  ) {}

  async pinKey(serverUrl: string, changeId: string): Promise<string> {
    const read = await this.kept.readRecord(pinsOf(serverUrl)).catch((): Pins => ({}));
    const found = read[changeId];
    if (found !== undefined && fresh(found, this.now())) return found.key;
    try {
      return await this.#pinAndPrune(serverUrl, changeId, (kept, now) =>
        kept !== undefined && fresh(kept, now)
          ? kept
          : { key: kept?.key ?? newOpenKey(changeId), usedAt: now },
      );
    } catch (cause) {
      if (cause instanceof Unwritable) return found?.key ?? unkeptKey(changeId);
      throw cause;
    }
  }

  /** A new key for this change: the next `reviews/open` pins a slice of the worktree as it is now. */
  async repin(serverUrl: string, changeId: string): Promise<string> {
    return this.#pinAndPrune(serverUrl, changeId, (_found, now) => ({
      key: newOpenKey(changeId),
      usedAt: now,
    }));
  }

  async #pinAndPrune(
    serverUrl: string,
    changeId: string,
    choose: (found: Pin | undefined, now: number) => Pin,
  ): Promise<string> {
    const now = this.now();
    const pins = await this.kept.updateRecord(pinsOf(serverUrl), (kept) => {
      const found = kept[changeId];
      const pin = choose(found, now);
      if (pin === found) return kept;
      return { ...withoutUnused(kept, now), [changeId]: pin };
    });
    const pin = pins[changeId];
    if (pin === undefined) throw new Error("VS Code did not keep the key pinning this change.");
    return pin.key;
  }
}
