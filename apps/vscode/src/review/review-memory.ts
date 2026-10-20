import { randomUUID } from "node:crypto";

/**
 * What the review keeps on this machine, in the extension's `globalState` under `mend.review`, per
 * server URL: the key that pins each change's slice, so a reload and every window show the same
 * slice. `reviews/open` answers the same slice for the same key.
 */

export const REVIEW_MEMORY_KEY = "mend.review";

export interface ReviewMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void>;
}

/** One server's review memory. */
export interface ServerMemory {
  /** The open key pinning each change's slice, by change id. */
  readonly pins: Readonly<Record<string, string>>;
}

const EMPTY: ServerMemory = { pins: {} };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): Readonly<Record<string, string>> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) =>
          typeof item === "string" ? [[key, item]] : [],
        ),
      )
    : {};

/** A server's memory as stored; anything unreadable reads as nothing kept. */
export const parseServerMemory = (value: unknown): ServerMemory =>
  isRecord(value) ? { pins: strings(value["pins"]) } : EMPTY;

export const newOpenKey = (changeId: string): string => `vscode-review:${changeId}:${randomUUID()}`;

export class ReviewMemory {
  constructor(private readonly memento: ReviewMemento) {}

  read(serverUrl: string): ServerMemory {
    const all = this.memento.get(REVIEW_MEMORY_KEY);
    return parseServerMemory(isRecord(all) ? all[serverUrl] : undefined);
  }

  async write(serverUrl: string, next: ServerMemory): Promise<void> {
    const all = this.memento.get(REVIEW_MEMORY_KEY);
    await this.memento.update(REVIEW_MEMORY_KEY, {
      ...(isRecord(all) ? all : {}),
      [serverUrl]: next,
    });
  }

  /** The key pinning this change's slice, made and kept the first time it is asked for. */
  async pinKey(serverUrl: string, changeId: string): Promise<string> {
    const memory = this.read(serverUrl);
    const known = memory.pins[changeId];
    if (known !== undefined) return known;
    return this.repin(serverUrl, changeId);
  }

  /** A new key for this change: the next `reviews/open` pins a slice of the worktree as it is now. */
  async repin(serverUrl: string, changeId: string): Promise<string> {
    const memory = this.read(serverUrl);
    const key = newOpenKey(changeId);
    await this.write(serverUrl, { ...memory, pins: { ...memory.pins, [changeId]: key } });
    return key;
  }
}
