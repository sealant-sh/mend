import { createHash, randomBytes } from "node:crypto";

/**
 * Pickup tickets: how a secret reaches a workspace without riding an exec's arguments.
 *
 * The platform keeps every exec's argv, in plaintext and for good (Core's `telemetry_events`,
 * `telemetry_timeline` and the job row; review of mend#552/#553, P1-1). So no secret goes there.
 * Mend mints a ticket instead, puts only the ticket in the argv, and the same exec redeems it over
 * the session channel, the authenticated connection the workspace already uses to reach Mend,
 * writing what it gets straight into its 0600 file. What the platform records is a ticket that is
 * spent or expired, worth nothing.
 *
 * A ticket is 32 random bytes, good for one redemption within `PICKUP_TICKET_TTL_MS`, and bound to
 * what it was minted for: the purpose, the session and its worktree, the person whose secret it
 * carries and the launch of the executor it was minted for. The store keeps a ticket's SHA-256,
 * never the ticket, and nothing here logs either. A redemption takes the ticket whatever it
 * answers, so a ticket presented once, by anyone, is gone.
 */

/** How long a ticket stays redeemable: the exec that carries it redeems it at once. */
export const PICKUP_TICKET_TTL_MS = 30_000;

/** A ticket's shape: 32 bytes as unpadded base64url. Anything else is never looked up. */
export const PICKUP_TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** What a ticket may be redeemed for. */
export type PickupPurpose = "secret-files" | "pi-profile";

/** What a ticket is bound to. */
export interface PickupBinding {
  readonly purpose: PickupPurpose;
  /** The session the delivery is for. */
  readonly sessionId: string;
  readonly worktreeId: string;
  /** The person whose secret the ticket carries: the session's owner. */
  readonly personId: string;
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

export interface PickupTickets {
  /** A fresh ticket for `files`, redeemable once within the TTL. */
  readonly mint: (binding: PickupBinding, files: ReadonlyArray<PickupFile>) => string;
  /** The ticket's entry, taken: never answered twice. Null when unknown, spent or expired. */
  readonly take: (ticket: string) => PickupEntry | null;
  /** Forget a ticket, redeemed or not: the exec that carried it has ended. */
  readonly discard: (ticket: string) => void;
  /** Tickets held now (tests). */
  readonly size: () => number;
}

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
      // The bytes go when the ticket does, redeemed or not: nothing outlives the TTL in memory.
      const timer = setTimeout(() => held.delete(key), ttlMs);
      timer.unref?.();
      held.set(key, { binding, files, expiresAt: now() + ttlMs, timer });
      return ticket;
    },
    take: (ticket) => {
      if (!PICKUP_TICKET_SHAPE.test(ticket)) return null;
      const key = keyOf(ticket);
      const entry = held.get(key);
      if (entry === undefined) return null;
      drop(key);
      if (now() >= entry.expiresAt) return null;
      return { binding: entry.binding, files: entry.files };
    },
    discard: (ticket) => {
      if (PICKUP_TICKET_SHAPE.test(ticket)) drop(keyOf(ticket));
    },
    size: () => held.size,
  };
};

/** The channel a redemption arrived through: its session (or standby) id, and its launch. */
export interface PickupChannel {
  readonly sessionId: string;
  /** The launch the channel's token names; null over the Unix socket, which names none. */
  readonly launchId: string | null;
}

/**
 * Whether a ticket bound to `binding` may be redeemed through `channel`, as far as the ticket and
 * the channel alone can say: `"yes"` when both name a launch and it is the same one, `"no"` when
 * both name one and they differ, and `"ask"` otherwise, when the caller must check the channel's
 * session against the binding (same worktree, same owner).
 */
export const pickupChannelMatch = (
  binding: PickupBinding,
  channel: PickupChannel,
): "yes" | "no" | "ask" => {
  if (binding.launchId !== null && channel.launchId !== null) {
    return binding.launchId === channel.launchId ? "yes" : "no";
  }
  return "ask";
};

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
