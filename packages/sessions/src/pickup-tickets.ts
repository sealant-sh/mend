import { createHash, randomBytes } from "node:crypto";

/**
 * Pickup tickets: how a secret reaches a workspace without riding an exec's arguments.
 *
 * The platform keeps every exec's argv, in plaintext and for good (Core's `telemetry_events`,
 * `telemetry_timeline` and the job row, which holds it from the moment the exec is queued; review
 * of mend#552/#553, P1-1). So no secret goes there. Mend mints a ticket instead, puts only the
 * ticket in the argv, and the same exec redeems it over the session channel, the authenticated
 * connection the workspace already uses to reach Mend, writing what it gets straight into its
 * file. What the platform stores is a ticket that is spent or discarded by the time the exec ends,
 * and useless without a live channel credential for that executor.
 *
 * A ticket is 32 random bytes, good for one redemption, and bound to what it was minted for: the
 * purpose, the session and its worktree, the person whose files it carries and the launch of the
 * executor it was minted for. The engine discards it when the exec that carried it ends;
 * `PICKUP_TICKET_TTL_MS` is only the backstop for an exec that never returns. The store keeps a
 * ticket's SHA-256, never the ticket, and nothing here logs either. A redemption takes the ticket
 * whatever it answers, so a ticket presented once, by anyone, is gone; its hash stays as a
 * tombstone until the backstop, so a second presentation reads as what it is.
 */

/**
 * The backstop: how long an unredeemed ticket lives if the exec carrying it never ends. Longer
 * than the longest an exec waits for a slot on Core's run-exec queue (four per worker, shared
 * with installs and setup commands that run for minutes), so a busy instance never expires a
 * ticket before its exec runs (review of mend#555, P2-1).
 */
export const PICKUP_TICKET_TTL_MS = 10 * 60_000;

/** A ticket's shape: 32 bytes as unpadded base64url. Anything else is never looked up. */
export const PICKUP_TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** What a ticket may be redeemed for. */
export type PickupPurpose = "secret-files" | "pi-profile" | "workspace-files";

/** What a ticket is bound to. */
export interface PickupBinding {
  readonly purpose: PickupPurpose;
  /** The session the delivery is for. */
  readonly sessionId: string;
  readonly worktreeId: string;
  /** The person whose files the ticket carries: the session's owner (null: a session of nobody). */
  readonly personId: string | null;
  /** The launch of the executor the delivery writes into, when Mend knows it. */
  readonly launchId: string | null;
}

/** One file a ticket carries: a path the exec already holds, and its bytes. */
export interface PickupFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PickupEntry {
  readonly binding: PickupBinding;
  readonly files: ReadonlyArray<PickupFile>;
}

/** What taking a ticket found. */
export type PickupTake =
  | { readonly kind: "taken"; readonly entry: PickupEntry }
  /** Presented before: someone redeemed it already, perhaps not its exec. */
  | { readonly kind: "spent"; readonly binding: PickupBinding }
  /** Never minted here, discarded, past the backstop, or not a ticket at all. */
  | { readonly kind: "unknown" };

export interface PickupTickets {
  /** A fresh ticket for `files`, redeemable once. */
  readonly mint: (binding: PickupBinding, files: ReadonlyArray<PickupFile>) => string;
  /** Take the ticket: its entry once, `spent` after that, `unknown` otherwise. */
  readonly take: (ticket: string) => PickupTake;
  /** Forget a ticket not yet redeemed: the exec that carried it has ended. */
  readonly discard: (ticket: string) => void;
  /** Tickets redeemable now (tests). */
  readonly size: () => number;
}

/** A timer that never keeps the process alive on its own. */
const later = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return timer;
};

const keyOf = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

export const makePickupTickets = (
  options: { readonly ttlMs?: number; readonly now?: () => number } = {},
): PickupTickets => {
  const ttlMs = options.ttlMs ?? PICKUP_TICKET_TTL_MS;
  const now = options.now ?? Date.now;
  const held = new Map<
    string,
    PickupEntry & { readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout> }
  >();
  // A redeemed ticket's binding, never its files, until the backstop.
  const spent = new Map<string, { readonly binding: PickupBinding; readonly expiresAt: number }>();
  const drop = (key: string) => {
    const entry = held.get(key);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    held.delete(key);
  };
  return {
    mint: (binding, files) => {
      const ticket = randomBytes(32).toString("base64url");
      const key = keyOf(ticket);
      // The bytes go when the ticket does, redeemed or not: nothing outlives the backstop.
      const timer = later(() => held.delete(key), ttlMs);
      held.set(key, { binding, files, expiresAt: now() + ttlMs, timer });
      return ticket;
    },
    take: (ticket) => {
      if (!PICKUP_TICKET_SHAPE.test(ticket)) return { kind: "unknown" };
      const key = keyOf(ticket);
      const entry = held.get(key);
      if (entry === undefined) {
        const tomb = spent.get(key);
        return tomb !== undefined && now() < tomb.expiresAt
          ? { kind: "spent", binding: tomb.binding }
          : { kind: "unknown" };
      }
      drop(key);
      if (now() >= entry.expiresAt) return { kind: "unknown" };
      spent.set(key, { binding: entry.binding, expiresAt: entry.expiresAt });
      later(() => spent.delete(key), Math.max(0, entry.expiresAt - now()));
      return { kind: "taken", entry: { binding: entry.binding, files: entry.files } };
    },
    discard: (ticket) => {
      if (PICKUP_TICKET_SHAPE.test(ticket)) drop(keyOf(ticket));
    },
    size: () => held.size,
  };
};

/** The channel a redemption arrived through. */
export interface PickupChannel {
  /** The session (or standby) id the channel serves. */
  readonly sessionId: string;
  /** The launch the channel's token names; null over the Unix socket, which names none. */
  readonly launchId: string | null;
  /**
   * The person the channel's token is (a per-person token, docs/adr/0016 decision 4); null for
   * the workspace's own token and the Unix socket, which name nobody.
   */
  readonly accountId: string | null;
}

/** What `grant` the network channel hands `pickupAs`: the token's launch and person. */
export interface PickupGrant {
  readonly launchId: string;
  readonly accountId: string | null;
}

/**
 * Whether a ticket bound to `binding` may be redeemed through `channel`, as far as the ticket and
 * the channel alone can say. A person's token redeems only that person's ticket. Then `"yes"`
 * when both name a launch and it is the same one, `"no"` when they differ, and `"ask"` otherwise:
 * the caller checks the channel's session with `pickupSiblingMatch`.
 */
export const pickupChannelMatch = (
  binding: PickupBinding,
  channel: PickupChannel,
):
  | { readonly kind: "yes" }
  | { readonly kind: "ask" }
  | { readonly kind: "no"; readonly reason: string } => {
  if (channel.accountId !== null && channel.accountId !== binding.personId) {
    return { kind: "no", reason: "this pickup ticket is another person's" };
  }
  if (binding.launchId !== null && channel.launchId !== null) {
    return binding.launchId === channel.launchId
      ? { kind: "yes" }
      : { kind: "no", reason: "this pickup ticket is another executor's" };
  }
  if (channel.sessionId === binding.sessionId) return { kind: "yes" };
  return { kind: "ask" };
};

/**
 * The `"ask"` case: a channel of another session, with no launch to compare, may redeem only when
 * its session is in the ticket's worktree and has the ticket's owner. The socket a workspace
 * mounts is the session's that made it, a sibling of the one delivering.
 */
export const pickupSiblingMatch = (
  binding: PickupBinding,
  other: { readonly worktreeId: string; readonly ownerUserId: string | null } | null,
): boolean =>
  other !== null &&
  binding.personId !== null &&
  other.worktreeId === binding.worktreeId &&
  other.ownerUserId === binding.personId;

/** The answer a redemption sends the exec: each file's path and its bytes in base64. */
export const pickupAnswerOf = (
  files: ReadonlyArray<PickupFile>,
): { readonly files: ReadonlyArray<{ readonly path: string; readonly base64: string }> } => ({
  files: files.map((file) => ({
    path: file.path,
    base64: Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength).toString(
      "base64",
    ),
  })),
});
