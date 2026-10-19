import type { MendConnection } from "../config.js";
import { MendApiError } from "../mend-http.js";
import type { ReviewClient } from "./review-client.js";
import type { FileContents } from "./review-wire.js";

/**
 * What the diff editor shows of a change's file at a checkpoint, read from Mend and kept for one
 * connection. A checkpoint never changes, so what was read stays readable while Mend is offline;
 * another server or account never sees it.
 */

/** A file at a checkpoint. `absent` is the side its status says it is not on: added or deleted. */
export interface ChangeAddress {
  readonly worktreeId: string;
  readonly path: string;
  readonly at: string;
  readonly absent: boolean;
  /** The pinned slice whose new side this is; null for any other document. */
  readonly slice: string | null;
}

const MIB = 1024 * 1024;

const mib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

/** What the editor shows for a file's contents: never a cut file as if it were whole. */
export const documentText = (path: string, contents: FileContents): string => {
  switch (contents.kind) {
    case "binary":
      return `binary file · ${contents.size} bytes · not shown`;
    case "text":
      return contents.truncated
        ? `${path} is ${mib(contents.size)}. Mend reads a file up to 1 MiB, so this side is not shown and the two sides are not compared.`
        : contents.text;
  }
};

/** Documents read for one connection, the least recently read dropped past either bound. */
export class ContentCache {
  readonly #entries = new Map<string, string>();
  #identity: string | null = null;
  #bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  /** The text kept for `key` under this connection; another connection's is dropped first. */
  get(identity: string, key: string): string | undefined {
    if (identity !== this.#identity) {
      this.clear();
      this.#identity = identity;
      return undefined;
    }
    const found = this.#entries.get(key);
    if (found === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, found);
    return found;
  }

  /** Keeps `text`, unless the connection changed while it was read. */
  set(identity: string, key: string, text: string): void {
    if (identity !== this.#identity) return;
    const bytes = text.length * 2;
    if (bytes > this.maxBytes) return;
    this.#drop(key);
    this.#entries.set(key, text);
    this.#bytes += bytes;
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.maxEntries && this.#bytes <= this.maxBytes) break;
      this.#drop(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
    this.#identity = null;
  }

  #drop(key: string): void {
    const found = this.#entries.get(key);
    if (found === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= found.length * 2;
  }
}

/** Up to 200 documents and 64 MiB of text, about 32 diffs of files at the 1 MiB Mend reads. */
const MAX_ENTRIES = 200;
const MAX_BYTES = 64 * MIB;

const identityOf = (connection: MendConnection): string =>
  `${connection.url}\n${connection.token ?? ""}`;

export class ContentReader {
  readonly #cache = new ContentCache(MAX_ENTRIES, MAX_BYTES);

  constructor(
    private readonly client: Pick<ReviewClient, "contents">,
    private readonly connection: () => Promise<MendConnection>,
  ) {}

  /** The document for `address`; a file Mend has not got at that checkpoint fails, in words. */
  async read(address: ChangeAddress, key: string): Promise<string> {
    if (address.absent) return "";
    const identity = identityOf(await this.connection());
    const known = this.#cache.get(identity, key);
    if (known !== undefined) return known;
    let contents: FileContents;
    try {
      contents = await this.client.contents(address.worktreeId, address.path, address.at);
    } catch (cause) {
      if (cause instanceof MendApiError && cause.status === 404)
        throw new Error(`Mend has no ${address.path} at this checkpoint: ${cause.message}`, {
          cause,
        });
      throw cause;
    }
    const shown = documentText(address.path, contents);
    this.#cache.set(identity, key, shown);
    return shown;
  }

  /** Sign-out: nothing read stays. */
  clear(): void {
    this.#cache.clear();
  }
}
