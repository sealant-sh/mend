import { randomUUID } from "node:crypto";

import { parseSessionReview, type SessionReview } from "./pending.js";

/**
 * What the review keeps on this machine, in the extension's `globalState`: under `mend.review`, per
 * server URL, the key that pins each change's slice, so a reload and every window show the same
 * slice (`reviews/open` answers the same slice for the same key); and under one key per server and
 * session, her pending comments.
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

/** A session's review as kept, with the revision each write counts up. */
interface Kept {
  readonly rev: number;
  readonly review: SessionReview;
}

const revOf = (value: unknown): number => {
  const rev = isRecord(value) ? value["rev"] : undefined;
  return typeof rev === "number" && Number.isInteger(rev) ? rev : 0;
};

export class ReviewMemory {
  /**
   * The newest review this window wrote or read, per key. VS Code's `globalState` replaces its whole
   * value whenever the main process sends one back, and that can be an earlier write of this window
   * arriving late, or another window's: a read never goes back to a lower revision than it saw.
   */
  readonly #seen = new Map<string, Kept>();

  constructor(private readonly memento: ReviewMemento) {}

  #current(key: string): Kept {
    const value = this.memento.get(key);
    const stored: Kept = { rev: revOf(value), review: parseSessionReview(value) };
    const seen = this.#seen.get(key);
    const newest = seen !== undefined && seen.rev > stored.rev ? seen : stored;
    this.#seen.set(key, newest);
    return newest;
  }

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

  /**
   * A session's review on this machine: her pending comments. One `globalState` key per server and
   * session, so two windows writing two sessions never overwrite each other.
   */
  readSession(serverUrl: string, sessionId: string): SessionReview {
    return this.#current(sessionKey(serverUrl, sessionId)).review;
  }

  /**
   * Applies `update` to the session's review as stored now, not as this window last read it: two
   * windows on one session each keep what the other wrote. Nothing is written when nothing changed.
   */
  async updateSession(
    serverUrl: string,
    sessionId: string,
    update: (stored: SessionReview) => SessionReview,
  ): Promise<SessionReview> {
    const key = sessionKey(serverUrl, sessionId);
    const { rev, review } = this.#current(key);
    const next = update(review);
    if (JSON.stringify(next) === JSON.stringify(review)) return next;
    this.#seen.set(key, { rev: rev + 1, review: next });
    await this.memento.update(key, { ...next, rev: rev + 1 });
    return next;
  }
}

export const sessionKey = (serverUrl: string, sessionId: string): string =>
  `${REVIEW_MEMORY_KEY}.session:${serverUrl}:${sessionId}`;
