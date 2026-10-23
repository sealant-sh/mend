import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { needs } from "./delivery.js";
import { asComposed, parseSessionReview, type SessionReview, type Unread } from "./pending.js";

/** Whose review it is: one person, signed in to one server, on one session. */
export interface ReviewPlace {
  readonly url: string;
  /** Her account on that server, as Mend names it: a sign-in Mend cannot name has no place. */
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

/**
 * A session's review untouched this long goes, unless it holds something she could still need:
 * nobody reviews a session a month on, and nothing of hers is lost when it goes.
 */
export const KEPT_REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A lock its holder has not renewed this long was left by a window that died holding it. */
const LOCK_STALE_MS = 10_000;
/** How often a window renews the lock it holds, so a slow write is never taken for a dead one. */
const LOCK_BEAT_MS = LOCK_STALE_MS / 4;
/** How long a write waits for another window's before it says it could not keep the review. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 15;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** A lease its window has not renewed this long belongs to no window. */
export const DRIVE_STALE_MS = 2 * 60 * 1000;
const DRIVE_BEAT_MS = DRIVE_STALE_MS / 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A session's review as kept, with its revision: a later write's is higher. */
export interface KeptReview {
  readonly rev: number;
  readonly review: SessionReview;
}

/**
 * The format this build writes a session's review in. Raise it only for a change an older build
 * would write back wrongly: it then leaves the file as it is. An entry an older build cannot read
 * (a new kind of send, phase or origin) needs no raise: that build writes it back where it was,
 * and sends no review after a send it cannot read.
 */
export const KEPT_FORMAT = 1;

/** A kind of file every window shares: what it keeps, in her words, and the format it is in. */
interface FileKind {
  readonly what: string;
  readonly format: number;
}

const REVIEW: FileKind = { what: "this session's review", format: KEPT_FORMAT };

/** A file every window shares, as stored: its fields, and whether this build may write it. */
interface Stored {
  readonly rev: number;
  /** Every field of the file: a write keeps each one this build does not write itself. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Why this build leaves the file as it is; null when it may write it. */
  readonly unwritable: string | null;
}

const NOTHING_STORED: Stored = { rev: 0, fields: {}, unwritable: null };

const FROM_NEWER =
  "Change it from a window that runs the newer version: reload this window if VS Code updated the extension.";

/** A shared file's text as stored; one a build before formats were kept wrote is format 1. */
const parseStored = (file: string, text: string, { what, format: mine }: FileKind): Stored => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const unreadable = (why: string): Stored => ({
    rev: 0,
    fields: {},
    unwritable: `The file VS Code keeps ${what} in ${why}, so VS Code leaves it as it is: ${file}.`,
  });
  if (!isRecord(value)) return unreadable("is not JSON");
  const format = value["format"] ?? 1;
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1)
    return unreadable("names no format this version of the Mend extension reads");
  const rev = value["rev"];
  return {
    rev: typeof rev === "number" && Number.isInteger(rev) ? rev : 0,
    fields: value,
    unwritable:
      format > mine
        ? `A newer version of the Mend extension wrote ${what}, so this version leaves it as that version wrote it. ${FROM_NEWER}`
        : null,
  };
};

/** A kept review as this build reads it, and the entries it cannot, to write back as they were. */
interface Opened {
  readonly stored: Stored;
  readonly kept: KeptReview;
  readonly unread: Unread;
}

const openReview = (stored: Stored): Opened => {
  const { review, unread } = parseSessionReview(stored.fields["review"]);
  return { stored, kept: { rev: stored.rev, review }, unread };
};

/**
 * A record of this machine every window reads and writes, in its own file beside the reviews:
 * the keys pinning each change's slice, what this VS Code last looked at. A write keeps only what
 * `parse` reads, so any change to the record's shape raises its `format`.
 */
export interface SharedRecord<T> extends FileKind {
  /** Its file, under the directory the reviews are kept in. */
  readonly name: string;
  /** The record as stored; nothing stored reads as `undefined`. */
  readonly parse: (stored: unknown) => T;
}

/**
 * Whether a kept file holds nothing she could still need: no comment she has not sent, no words of
 * a review she is writing, no send unfinished or waiting on her, and nothing this build cannot read.
 */
const holdsNothing = ({ stored, kept: { review }, unread }: Opened): boolean =>
  stored.unwritable === null &&
  unread.pending.length === 0 &&
  unread.sends.length === 0 &&
  unread.document === null &&
  review.pending.length === 0 &&
  review.replaced.length === 0 &&
  (review.document === null || asComposed(review.document)) &&
  review.sends.every((record) => needs(record) === "nothing");

/** `review` as stored, with every entry this build could not read written back as it was. */
const storedReview = (
  stored: unknown,
  review: SessionReview,
  unread: Unread,
): Record<string, unknown> => {
  if (review.document !== null && unread.document !== null)
    throw new Error(
      `A newer version of the Mend extension keeps the review you are writing for this session, so this version does not compose another. ${FROM_NEWER}`,
    );
  const fields = isRecord(stored) ? stored : {};
  const sent = Array.isArray(fields["sends"]) ? fields["sends"] : [];
  const keys = new Set(sent.map((entry) => (isRecord(entry) ? entry["key"] : undefined)));
  if (unread.sends.length > 0 && review.sends.some(({ key }) => !keys.has(key)))
    throw new Error(
      `A newer version of the Mend extension sent a review of this session that this version cannot read, so this version sends no other: it cannot tell what that review pasted. ${FROM_NEWER}`,
    );
  return {
    ...fields,
    ...review,
    pending: inPlace(fields["pending"], review.pending, unread.pending, "id", ({ id }) => id),
    sends: inPlace(fields["sends"], review.sends, unread.sends, "key", ({ key }) => key),
    document: review.document ?? unread.document,
  };
};

/**
 * Each of `next`'s entries where the stored one with its id was, each one this build could not
 * read where it was, then the new ones: a send's place is when it was sent, which a newer build
 * reads its latest by.
 */
const inPlace = <T>(
  stored: unknown,
  next: ReadonlyArray<T>,
  unread: ReadonlyArray<unknown>,
  field: "id" | "key",
  idOf: (entry: T) => string,
): ReadonlyArray<unknown> => {
  const left = new Map(next.map((entry) => [idOf(entry), entry]));
  const kept = new Set(unread);
  const placed = (Array.isArray(stored) ? stored : []).flatMap((entry): ReadonlyArray<unknown> => {
    if (kept.has(entry)) return [entry];
    const id = isRecord(entry) ? entry[field] : undefined;
    const found = typeof id === "string" ? left.get(id) : undefined;
    if (typeof id !== "string" || found === undefined) return [];
    left.delete(id);
    return [found];
  });
  return [...placed, ...left.values()];
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A lock or lease reads `<ms> <owner>`: when its holder last renewed it, then who holds it. */
const HOLD = /^(\d+) ?(.*)$/s;
const holdText = (at: number, owner: string): string => `${at} ${owner}`;
const heldAt = (text: string): number | null => {
  const at = HOLD.exec(text)?.[1];
  return at === undefined ? null : Number(at);
};
const heldBy = (text: string): string | null => HOLD.exec(text)?.[2] ?? null;

/** A hold this window renews: whether it still has it, a renewal now, and the end of renewing. */
interface Renewed {
  readonly held: () => Promise<boolean>;
  /** Renews it now, and answers whether this window still had it to renew. */
  readonly beat: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
}

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
  /** This window, as its drive leases name it. */
  readonly #window = randomUUID();
  /** When each person's directory was last swept. */
  readonly #swept = new Map<string, number>();
  /** The leases this window drives sends under, by file, each renewed while it lasts. */
  readonly #drives = new Map<string, Renewed>();

  constructor(
    private readonly directory: string,
    private readonly files: KeptFiles = NODE_FILES,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The session's review as kept now; nothing kept reads as no comment. A file this build leaves as
   * it is reads as far as this build reads it.
   */
  async read(place: ReviewPlace): Promise<KeptReview> {
    return openReview(await this.#stored(this.#file(place), REVIEW)).kept;
  }

  /**
   * Applies `update` to the review as kept now, never to a copy this window read earlier, and
   * answers what was kept. Nothing is written when nothing changed. A write that fails throws, and
   * what is kept stays as it was; so does a write to a file this build leaves as it is.
   */
  async update(
    place: ReviewPlace,
    update: (kept: SessionReview) => SessionReview | Promise<SessionReview>,
  ): Promise<KeptReview> {
    const file = this.#file(place);
    return this.#serial(file, async () => {
      await this.#sweep(file);
      return this.#locked(file, REVIEW, async (held) => {
        const opened = openReview(await this.#stored(file, REVIEW));
        const current = opened.kept;
        const next = await update(current.review);
        if (JSON.stringify(next) === JSON.stringify(current.review)) return current;
        const review = storedReview(opened.stored.fields["review"], next, opened.unread);
        return {
          rev: await this.#replace(file, REVIEW, opened.stored, { review }, held),
          review: next,
        };
      });
    });
  }

  /** The record as kept now, as far as this build reads it. */
  async readRecord<T>(record: SharedRecord<T>): Promise<T> {
    const file = join(this.directory, record.name);
    return record.parse((await this.#stored(file, record)).fields["record"]);
  }

  /**
   * Applies `update` to the record as kept now, as `update` does to a review, and answers what was
   * kept: under its lock, so one window's write keeps what another wrote.
   */
  async updateRecord<T>(record: SharedRecord<T>, update: (kept: T) => T): Promise<T> {
    const file = join(this.directory, record.name);
    return this.#serial(file, () =>
      this.#locked(file, record, async (held) => {
        const stored = await this.#stored(file, record);
        const current = record.parse(stored.fields["record"]);
        const next = update(current);
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        await this.#replace(file, record, stored, { record: next }, held);
        return next;
      }),
    );
  }

  /** One write at a time per file in this window, so it never waits on its own lock. */
  async #serial<T>(file: string, work: () => Promise<T>): Promise<T> {
    const before = this.#queued.get(file) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    this.#queued.set(file, run);
    try {
      return await run;
    } finally {
      if (this.#queued.get(file) === run) this.#queued.delete(file);
    }
  }

  async #stored(file: string, kind: FileKind): Promise<Stored> {
    try {
      return parseStored(file, await this.files.readFile(file), kind);
    } catch (cause) {
      if (codeOf(cause) === "ENOENT") return NOTHING_STORED;
      throw cause;
    }
  }

  /**
   * Writes `fields` over the file as stored, keeping every other field, while this window still
   * holds its lock, and answers the revision written.
   */
  async #replace(
    file: string,
    kind: FileKind,
    stored: Stored,
    fields: Readonly<Record<string, unknown>>,
    held: () => Promise<boolean>,
  ): Promise<number> {
    if (stored.unwritable !== null) throw new Error(stored.unwritable);
    // Never below the clock: a file swept or removed and written anew stays newer than any
    // revision a window read before.
    const rev = Math.max(stored.rev + 1, this.now());
    const written = `${file}.${randomUUID()}.tmp`;
    try {
      await this.files.writeFile(
        written,
        JSON.stringify({ ...stored.fields, ...fields, format: kind.format, rev }),
      );
      if (!(await held()))
        throw new Error(
          `another window of VS Code took over writing ${kind.what}; this change was not kept.`,
        );
      await this.files.rename(written, file);
    } catch (cause) {
      await this.files.rm(written).catch(() => undefined);
      throw cause;
    }
    return rev;
  }

  /**
   * One window drives a send: the one holding its lease, a file created only when absent and
   * renewed while that window lives, through every wait on Mend. False when another window holds
   * a fresh one; a lease past `DRIVE_STALE_MS` was left by a window that closed, and is taken over.
   */
  async claimDrive(place: ReviewPlace, key: string): Promise<boolean> {
    const lease = this.#lease(place, key);
    await this.files.mkdir(dirname(lease));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await this.#take(lease, this.#window)) || (await this.#holds(lease, this.#window))) {
        if (!this.#drives.has(lease))
          this.#drives.set(lease, this.#renew(lease, this.#window, DRIVE_BEAT_MS));
        return true;
      }
      if (!(await this.#breakStale(lease, DRIVE_STALE_MS))) return false;
    }
    return false;
  }

  /**
   * Renews this window's lease on the send, and answers whether it still drives it: false once
   * another window took it over, after which this window must do nothing more for that send.
   */
  async renewDrive(place: ReviewPlace, key: string): Promise<boolean> {
    return (await this.#drives.get(this.#lease(place, key))?.beat()) ?? false;
  }

  async releaseDrive(place: ReviewPlace, key: string): Promise<void> {
    const lease = this.#lease(place, key);
    await this.#drives.get(lease)?.stop();
    this.#drives.delete(lease);
    await this.#release(lease, this.#window);
  }

  drives(place: ReviewPlace, key: string): boolean {
    return this.#drives.has(this.#lease(place, key));
  }

  /**
   * How long another window drives this send for, in ms, unless it renews its lease: after that the
   * lease is stale. Null when no other window drives it now.
   */
  async drivenFor(place: ReviewPlace, key: string): Promise<number | null> {
    const lease = this.#lease(place, key);
    const text = await this.#holdOf(lease);
    if (text === null || heldBy(text) === this.#window) return null;
    const at = heldAt(text) ?? (await this.files.modified(lease));
    const left = at === null ? 0 : at + DRIVE_STALE_MS - this.now();
    return left > 0 ? left : null;
  }

  #lease(place: ReviewPlace, key: string): string {
    return `${this.#file(place)}.${encodeURIComponent(key)}.drive`;
  }

  async #locked<T>(
    file: string,
    kind: FileKind,
    body: (held: () => Promise<boolean>) => Promise<T>,
  ): Promise<T> {
    await this.files.mkdir(dirname(file));
    const lock = `${file}.lock`;
    const owner = randomUUID();
    const began = this.now();
    while (!(await this.#take(lock, owner))) {
      if (await this.#breakStale(lock, LOCK_STALE_MS)) continue;
      if (this.now() - began >= LOCK_WAIT_MS)
        throw new Error(`another window of VS Code is still writing ${kind.what}.`);
      await pause(LOCK_POLL_MS);
    }
    const renewed = this.#renew(lock, owner, LOCK_BEAT_MS);
    try {
      return await body(renewed.held);
    } finally {
      await renewed.stop();
      await this.#release(lock, owner).catch(() => undefined);
    }
  }

  /** Takes `path` for `owner` when nobody holds it. */
  async #take(path: string, owner: string): Promise<boolean> {
    try {
      await this.files.create(path, holdText(this.now(), owner));
      return true;
    } catch (cause) {
      if (codeOf(cause) === "EEXIST") return false;
      throw cause;
    }
  }

  async #holdOf(path: string): Promise<string | null> {
    return this.files.readFile(path).then(
      (text) => text,
      () => null,
    );
  }

  async #holds(path: string, owner: string): Promise<boolean> {
    const text = await this.#holdOf(path);
    return text !== null && heldBy(text) === owner;
  }

  async #release(path: string, owner: string): Promise<void> {
    if (await this.#holds(path, owner)) await this.files.rm(path);
  }

  /**
   * Breaks a hold its holder stopped renewing `staleMs` ago, and answers whether to try taking it
   * again. It breaks only under the breaker, a file created only when absent, and only while the
   * hold reads as it did when found stale: of two windows that found it stale at once, the later
   * reads the hold the earlier took since, and leaves it.
   */
  async #breakStale(path: string, staleMs: number): Promise<boolean> {
    const seen = await this.#holdOf(path);
    if (seen === null) return true;
    if (!(await this.#stale(path, seen, staleMs))) return false;
    const breaker = `${path}.break`;
    if (!(await this.#take(breaker, randomUUID()))) {
      // A window that died breaking it left the breaker, which goes stale in turn.
      const other = await this.#holdOf(breaker);
      if (other !== null && (await this.#stale(breaker, other, staleMs)))
        await this.files.rm(breaker);
      return false;
    }
    try {
      if ((await this.#holdOf(path)) === seen) await this.files.rm(path);
      return true;
    } finally {
      await this.files.rm(breaker).catch(() => undefined);
    }
  }

  /** A hold with no time in it was cut short by a crash mid-renewal, so its file's age counts. */
  async #stale(path: string, text: string, staleMs: number): Promise<boolean> {
    const at = heldAt(text) ?? (await this.files.modified(path));
    return at !== null && this.now() - at >= staleMs;
  }

  /**
   * Renews `owner`'s hold on `path` every `everyMs` while it still has it. Asking whether it does
   * waits for the renewal in flight. A renewal renames a new hold over the old one, so another
   * window never reads a hold half written: an empty one would count by the file's age instead.
   */
  #renew(path: string, owner: string, everyMs: number): Renewed {
    let last: Promise<unknown> = Promise.resolve();
    const queue = <T>(work: () => Promise<T>): Promise<T> => {
      const next = last.then(work);
      last = next.catch(() => undefined);
      return next;
    };
    const beat = (): Promise<boolean> =>
      queue(async () => {
        if (!(await this.#holds(path, owner))) return false;
        const renewal = `${path}.${randomUUID()}.tmp`;
        try {
          await this.files.writeFile(renewal, holdText(this.now(), owner));
          await this.files.rename(renewal, path);
        } catch (cause) {
          await this.files.rm(renewal).catch(() => undefined);
          throw cause;
        }
        return true;
      });
    const timer = setInterval(() => void beat().catch(() => undefined), everyMs);
    timer.unref();
    return {
      held: () => queue(() => this.#holds(path, owner)),
      beat,
      stop: async () => {
        clearInterval(timer);
        await last;
      },
    };
  }

  /**
   * Reviews untouched past the expiry that hold nothing she could still need, and what a crash
   * left, go; at most hourly. An expired review is read and goes only under its own lock, so a
   * window writing it at that moment keeps its write; the one `writing` is about to change stays.
   */
  async #sweep(writing: string): Promise<void> {
    const directory = dirname(writing);
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
        if (path === writing) return;
        if (/\.(tmp|stale|break)$/.test(name)) {
          if (await expired(path, LOCK_STALE_MS * 6)) await this.files.rm(path);
          return;
        }
        if (name.endsWith(".drive")) {
          if (await expired(path, DRIVE_STALE_MS * 2)) await this.files.rm(path);
          return;
        }
        if (!name.endsWith(".json") || !(await expired(path, KEPT_REVIEW_TTL_MS))) return;
        const lock = `${path}.lock`;
        const owner = randomUUID();
        if (!(await this.#take(lock, owner).catch(() => false))) return;
        try {
          if (
            (await expired(path, KEPT_REVIEW_TTL_MS)) &&
            (await this.#stored(path, REVIEW).then(
              (stored) => holdsNothing(openReview(stored)),
              () => false,
            ))
          )
            await this.files.rm(path);
        } finally {
          await this.#release(lock, owner).catch(() => undefined);
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
