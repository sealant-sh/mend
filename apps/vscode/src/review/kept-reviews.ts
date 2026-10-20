import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { EMPTY_REVIEW, parseSessionReview, type SessionReview } from "./pending.js";

/** Whose review it is: one person, signed in to one server, on one session. */
export interface ReviewPlace {
  readonly url: string;
  /** Her account on that server; `unknown` when Mend never said who she is. */
  readonly viewer: string;
  readonly sessionId: string;
}

export const samePlace = (left: ReviewPlace | null, right: ReviewPlace | null): boolean =>
  left !== null &&
  right !== null &&
  left.url === right.url &&
  left.viewer === right.viewer &&
  left.sessionId === right.sessionId;

/** The file operations the store makes, so a test can hold one back. */
export interface KeptFiles {
  readonly mkdir: (path: string) => Promise<unknown>;
  readonly readFile: (path: string) => Promise<string>;
  /** Creates `path` only when absent: the write fails with EEXIST otherwise. */
  readonly create: (path: string, text: string) => Promise<void>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  readonly readdir: (path: string) => Promise<ReadonlyArray<string>>;
  /** When the file was last written, in ms; null when it is gone. */
  readonly modified: (path: string) => Promise<number | null>;
}

const codeOf = (cause: unknown): unknown =>
  cause instanceof Error ? Reflect.get(cause, "code") : undefined;

export const NODE_FILES: KeptFiles = {
  mkdir: (path) => fs.mkdir(path, { recursive: true }),
  readFile: (path) => fs.readFile(path, "utf8"),
  create: (path, text) => fs.writeFile(path, text, { flag: "wx" }),
  writeFile: (path, text) => fs.writeFile(path, text),
  rename: (from, to) => fs.rename(from, to),
  rm: (path) => fs.rm(path, { force: true }),
  readdir: (path) => fs.readdir(path),
  modified: (path) =>
    fs.stat(path).then(
      (found) => found.mtimeMs,
      () => null,
    ),
};

/** A session's review untouched this long goes: nobody reviews a session a month on. */
export const KEPT_REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A lock older than this was left by a window that died holding it. */
const LOCK_STALE_MS = 10_000;
/** How long a write waits for another window's before it says it could not keep the review. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 15;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A session's review as kept, with the revision each write counts up. */
export interface KeptReview {
  readonly rev: number;
  readonly review: SessionReview;
}

const parseKept = (text: string): KeptReview => {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) return { rev: 0, review: EMPTY_REVIEW };
  const rev = value["rev"];
  return {
    rev: typeof rev === "number" && Number.isInteger(rev) ? rev : 0,
    review: parseSessionReview(value["review"]),
  };
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Her pending comments and the reviews she sent, per person and session, in one file each under
 * the extension's global storage, which every window of this VS Code shares. A write reads the
 * file, applies its change and renames a new file over it while it holds the session's lock (a
 * file created only when absent), so two windows writing one session at once each keep the
 * other's words, and one review is never sent twice. The extension's `globalState` cannot: each
 * window writes the whole value from its own cached copy, with no compare-and-set.
 */
export class KeptReviews {
  /** The writes this window has queued, per file: one at a time, so it never waits on itself. */
  readonly #queued = new Map<string, Promise<unknown>>();
  /** When each person's directory was last swept. */
  readonly #swept = new Map<string, number>();

  constructor(
    private readonly directory: string,
    private readonly files: KeptFiles = NODE_FILES,
    private readonly now: () => number = Date.now,
  ) {}

  /** The session's review as kept now; nothing kept reads as no comment. */
  async read(place: ReviewPlace): Promise<KeptReview> {
    try {
      return parseKept(await this.files.readFile(this.#file(place)));
    } catch (cause) {
      if (codeOf(cause) === "ENOENT" || cause instanceof SyntaxError)
        return { rev: 0, review: EMPTY_REVIEW };
      throw cause;
    }
  }

  /**
   * Applies `update` to the review as kept now, never to a copy this window read earlier, and
   * answers what was kept. Nothing is written when nothing changed. A write that fails throws, and
   * what is kept stays as it was.
   */
  async update(
    place: ReviewPlace,
    update: (kept: SessionReview) => SessionReview,
  ): Promise<KeptReview> {
    const file = this.#file(place);
    const before = this.#queued.get(file) ?? Promise.resolve();
    const run = before
      .catch(() => undefined)
      .then(() => this.#locked(file, () => this.#write(place, file, update)));
    this.#queued.set(file, run);
    try {
      return await run;
    } finally {
      if (this.#queued.get(file) === run) this.#queued.delete(file);
    }
  }

  async #write(
    place: ReviewPlace,
    file: string,
    update: (kept: SessionReview) => SessionReview,
  ): Promise<KeptReview> {
    const current = await this.read(place);
    const next = update(current.review);
    if (JSON.stringify(next) === JSON.stringify(current.review)) return current;
    const kept: KeptReview = { rev: current.rev + 1, review: next };
    const written = `${file}.${randomUUID()}.tmp`;
    try {
      await this.files.writeFile(written, JSON.stringify(kept));
      await this.files.rename(written, file);
    } catch (cause) {
      await this.files.rm(written).catch(() => undefined);
      throw cause;
    }
    return kept;
  }

  async #locked<T>(file: string, body: () => Promise<T>): Promise<T> {
    await this.files.mkdir(dirname(file));
    await this.#sweep(dirname(file));
    const lock = `${file}.lock`;
    const began = this.now();
    for (;;) {
      try {
        await this.files.create(lock, String(this.now()));
        break;
      } catch (cause) {
        if (codeOf(cause) !== "EEXIST") throw cause;
      }
      const made = await this.files.modified(lock);
      if (made !== null && this.now() - made >= LOCK_STALE_MS) {
        // Taken away under a name of its own, so of two windows that both found it stale only
        // one removes it.
        const stale = `${lock}.${randomUUID()}.stale`;
        await this.files.rename(lock, stale).then(
          () => this.files.rm(stale),
          () => undefined,
        );
        continue;
      }
      if (this.now() - began >= LOCK_WAIT_MS)
        throw new Error("another window of VS Code is still writing this review.");
      await pause(LOCK_POLL_MS);
    }
    try {
      return await body();
    } finally {
      await this.files.rm(lock).catch(() => undefined);
    }
  }

  /**
   * Reviews untouched past the expiry, and what a crash left, go; at most hourly. An expired
   * review goes only under its own lock, so a window writing it at that moment keeps its write.
   */
  async #sweep(directory: string): Promise<void> {
    if (this.now() - (this.#swept.get(directory) ?? Number.NEGATIVE_INFINITY) < SWEEP_EVERY_MS)
      return;
    this.#swept.set(directory, this.now());
    const names = await this.files.readdir(directory).catch(() => []);
    const expired = async (path: string, ttl: number): Promise<boolean> => {
      const made = await this.files.modified(path);
      return made !== null && this.now() - made >= ttl;
    };
    await Promise.all(
      names.map(async (name) => {
        const path = join(directory, name);
        if (/\.(tmp|stale)$/.test(name)) {
          if (await expired(path, LOCK_STALE_MS * 6)) await this.files.rm(path);
          return;
        }
        if (!name.endsWith(".json") || !(await expired(path, KEPT_REVIEW_TTL_MS))) return;
        const lock = `${path}.lock`;
        const locked = await this.files.create(lock, String(this.now())).then(
          () => true,
          () => false,
        );
        if (!locked) return;
        try {
          if (await expired(path, KEPT_REVIEW_TTL_MS)) await this.files.rm(path);
        } finally {
          await this.files.rm(lock).catch(() => undefined);
        }
      }),
    );
  }

  #file(place: ReviewPlace): string {
    return join(
      this.directory,
      encodeURIComponent(`${place.url} ${place.viewer}`),
      `${encodeURIComponent(place.sessionId)}.json`,
    );
  }
}
