import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AuthClientMetadataDeviceType,
  AuthEnvironmentScope,
  AuthSessionId,
  EnvironmentId,
  ModelFavorites,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectScript,
  ProviderModelPreferences,
} from "@mend/t3-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { GatewayConfig } from "./config.ts";
import { MendTurnSteer } from "./mend-workbench.ts";
import {
  NO_MODEL_PREFERENCES,
  type KeptModelPreferences,
  type ModelPreferences,
} from "./model-preferences.ts";
import type { EntryState, StoredEntry, StoredQueue } from "./queue.ts";
import type { SentSteer, SteerRecord } from "./steering.ts";

/**
 * The gateway's own state (ADR 0012, "State"): one `node:sqlite` file it owns. Mend's records stay
 * in Mend; losing this file loses only the environment id, paired bearers and t3code-side ids.
 *
 * The file holds every paired person's Mend device token, usable as that person: the gateway calls
 * Mend with it when no client request is in flight (the event stream, device checks, queued sends
 * and relaunches), and after a restart a reconnecting socket carries only a ticket. A hash cannot
 * make those calls, and a key kept beside the file protects nothing the file's mode does not. So
 * only the gateway's own user may read it (`restrictStateFile`).
 */

/** One t3code client's bearer, and the Mend device token it stands for. */
export interface BearerSession {
  readonly sessionId: AuthSessionId;
  /** sha256 of the bearer; the bearer itself is never stored. */
  readonly tokenHash: string;
  /** The device token Mend returned when the pairing code was claimed; every Mend call uses it. */
  readonly deviceToken: string;
  readonly mendUser: { readonly id: string; readonly name: string; readonly email: string };
  readonly mendDeviceId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly client: {
    readonly label: string | null;
    readonly deviceType: AuthClientMetadataDeviceType;
    readonly os: string | null;
  };
  /** Epoch milliseconds. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface NextChoices {
  readonly model?: string | null;
  readonly effort?: string | null;
}

/**
 * The t3code ids a gateway-sent turn carries (ADR 0012, "State"): the run id the gateway minted
 * when it queued the message, and the message id the t3code client sent it with. A client
 * reconciles its own message by that id, so the map outlives a gateway restart.
 */
export interface TurnIds {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly messageId: string;
}

/**
 * What a launch named for its session's agent (`LaunchRequest` in @mend/api-contracts), kept so
 * every later launch of the thread names the same: a launch that never brought an agent up leaves
 * Mend nothing recorded to reuse.
 */
export const ThreadLaunchOptions = Schema.Struct({
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  permissionMode: Schema.optional(Schema.Literals(["bypass", "ask"])),
});
export type ThreadLaunchOptions = typeof ThreadLaunchOptions.Type;

/**
 * A thread a t3code client launched (`orchestration.launchThread`): the client's own thread id,
 * the Mend session that is it, the launch command (a retry of it is the same thread) and what the
 * launch named.
 */
export interface LaunchedThread {
  readonly threadId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly options: ThreadLaunchOptions;
}

/** An image a t3code client attached to a message, as the state file keeps it (without its bytes). */
export interface StoredImage {
  readonly id: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly position: number;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Where Mend last placed it, for which session and agent; null before it was ever placed. */
  readonly placement: ImagePlacement | null;
}

/**
 * Where Mend placed an image (`POST /api/sessions/:id/images`): in one session's workspace, while
 * one agent process ran there. Another session, or a new agent, places it again.
 */
export interface ImagePlacement {
  readonly sessionId: string;
  readonly processId: string;
  readonly path: string;
}

/**
 * A person's settle, snooze, pin and order of a thread, as t3code keeps them on its own threads:
 * ISO times, null where unset. Mend has none of them, so it is the person's view alone.
 */
export interface ThreadLifecycle {
  /** `settled` after a settle, `active` after an unsettle; null for neither. */
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
  readonly unsettledAt: string | null;
  /** When the snooze ends; null while the thread is not snoozed. */
  readonly snoozedUntil: string | null;
  readonly snoozedAt: string | null;
  /** When the person last ended a snooze by hand, or by pinning: the quiet clock starts again. */
  readonly lastSnoozeWakeAt: string | null;
  readonly pinnedAt: string | null;
  readonly pinOrderKey: string | null;
  readonly activeOrderKey: string | null;
  readonly autoSettleDisabledAt: string | null;
}

/**
 * How a person's settle, snooze, pin or order command was answered, kept by its command id as
 * t3code's own server keeps a command receipt: a client sending the command again (a retry of one
 * it saw no answer to) gets the same answer, and the command is never applied twice.
 */
export interface LifecycleReceipt {
  readonly commandId: string;
  /** The session whose thread the command was for. */
  readonly sessionId: string;
  readonly answer:
    | { readonly _tag: "Applied"; readonly sequence: number }
    | { readonly _tag: "Refused"; readonly reason: string };
}

/** An image as a sent message carried it: the selection and the path its turn named. */
export interface SentImage {
  readonly imageId: string;
  readonly path: string;
}

export class GatewayStateError extends Schema.TaggedError<GatewayStateError>()(
  "GatewayStateError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The gateway's state file failed during ${this.operation}.`;
  }
}

export class GatewayState extends Context.Service<
  GatewayState,
  {
    /** Generated once, on the first start, and kept: a client keys its saved environment by it. */
    readonly environmentId: EnvironmentId;
    readonly insertSession: (session: BearerSession) => Effect.Effect<void, GatewayStateError>;
    readonly findSession: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<BearerSession>, GatewayStateError>;
    /** The session a WebSocket ticket was issued for. */
    readonly findSessionById: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<BearerSession>, GatewayStateError>;
    readonly revokeSession: (
      sessionId: AuthSessionId,
      at: number,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Revokes every bearer standing for a Mend device token Mend refused. */
    readonly revokeSessionsForDevice: (
      deviceToken: string,
      at: number,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Records the t3code ids of a turn the gateway sent. */
    readonly recordTurnIds: (ids: TurnIds, at: number) => Effect.Effect<void, GatewayStateError>;
    /** Every turn the gateway sent, with its t3code ids. */
    readonly listTurnIds: () => Effect.Effect<ReadonlyArray<TurnIds>, GatewayStateError>;
    /**
     * Records a thread a person launched from t3code; a second record of its command keeps the
     * first.
     */
    readonly recordThread: (
      mendUserId: string,
      thread: LaunchedThread,
      at: number,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Every thread a person launched from t3code whose session was not seen removed. */
    readonly listThreads: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyArray<LaunchedThread>, GatewayStateError>;
    /**
     * Forgets a thread a person deleted: its client id, when they launched it, and the receipts of
     * their commands for it.
     */
    readonly forgetThread: (
      mendUserId: string,
      sessionId: string,
    ) => Effect.Effect<void, GatewayStateError>;
    /**
     * Keeps a session a person deleted that Mend keeps until its workspace has stopped, so it stays
     * hidden from them across a restart.
     */
    readonly keepRemoval: (
      mendUserId: string,
      sessionId: string,
      at: number,
    ) => Effect.Effect<void, GatewayStateError>;
    /** The sessions a person deleted that Mend had not removed when last read. */
    readonly listRemovals: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyArray<string>, GatewayStateError>;
    /** Forgets a pending removal once Mend no longer lists the session. */
    readonly dropRemoval: (
      mendUserId: string,
      sessionId: string,
    ) => Effect.Effect<void, GatewayStateError>;
    /**
     * Keeps one thread's queue in a person's hub as it stands now; an empty queue that is not held
     * leaves nothing behind.
     */
    readonly saveQueue: (
      mendUserId: string,
      sessionId: string,
      queue: StoredQueue,
      /** Settled steers to keep, by client steer id; null forgets one. */
      sent?: ReadonlyMap<string, SentSteer | null>,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Every settled steer kept for a person, by session (`steering.ts`, `SentSteer`). */
    readonly listSentSteers: (
      mendUserId: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly sessionId: string; readonly steer: SentSteer }>,
      GatewayStateError
    >;
    /**
     * Every queue kept for a person, by session, with the device tokens of the senders whose
     * bearer is still live (a sender missing from `senders` is no longer paired).
     */
    readonly loadQueues: (mendUserId: string) => Effect.Effect<
      ReadonlyArray<{
        readonly sessionId: string;
        readonly queue: StoredQueue;
        readonly senders: ReadonlyMap<string, string>;
      }>,
      GatewayStateError
    >;
    /**
     * Reserves `count` sequences at or above `from`, from one high-water mark for the whole
     * gateway, and answers where they start: every sequence a hub stamps comes from a reservation,
     * so none is stamped twice across hubs, people and restarts, and a client resuming after a
     * sequence from another hub is never answered by replay. The mark starts at the clock (in
     * milliseconds), above any sequence a gateway gave before it kept one: those counted from 0.
     */
    readonly reserveSequences: (
      from: number,
      count: number,
    ) => Effect.Effect<number, GatewayStateError>;
    /** Keeps a person's images for a message, bytes and all, until the message is sent and after. */
    readonly saveImages: (
      mendUserId: string,
      images: ReadonlyArray<StoredImage & { readonly bytes: Uint8Array }>,
      at: number,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Every image a person attached, without its bytes. */
    readonly listImages: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyArray<StoredImage>, GatewayStateError>;
    /** One of a person's images, with its bytes, or null when it is not theirs or is gone. */
    readonly imageBytes: (
      mendUserId: string,
      imageId: string,
    ) => Effect.Effect<
      { readonly image: StoredImage; readonly bytes: Uint8Array } | null,
      GatewayStateError
    >;
    /** Records where Mend placed one of a person's images. */
    readonly recordImagePlacement: (
      mendUserId: string,
      imageId: string,
      placement: ImagePlacement,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Records the images a message carried when Mend took its turn, in order. */
    readonly recordSentImages: (
      mendUserId: string,
      messageId: string,
      images: ReadonlyArray<SentImage>,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Message id → the images it carried when sent, for each of a person's sent messages. */
    readonly listSentImages: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<SentImage>>, GatewayStateError>;
    /**
     * Lets go of images older than `before` that no sent message carried and no kept message
     * carries (a draft the client dropped), a person's or everyone's, and answers which.
     */
    readonly pruneImages: (
      before: number,
      mendUserId: string | null,
    ) => Effect.Effect<ReadonlyArray<string>, GatewayStateError>;
    /** The permission mode a person chose for a session's next launch; null clears it. */
    readonly setNextMode: (
      mendUserId: string,
      sessionId: string,
      mode: "bypass" | "ask" | null,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Every next-launch mode a person chose, by session. */
    readonly listNextModes: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyMap<string, "bypass" | "ask">, GatewayStateError>;
    /** Archives a person's thread at `at` (ISO), or, for null, takes it out of their archive. */
    readonly setArchived: (
      mendUserId: string,
      sessionId: string,
      at: string | null,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Session id → when the person archived it. */
    readonly listArchived: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyMap<string, string>, GatewayStateError>;
    /**
     * Keeps a person's settle, snooze, pin and order of a thread, or, for null, lets go of all; with
     * a receipt, keeps the command that changed them in the same transaction, so neither is kept
     * without the other.
     */
    readonly setLifecycle: (
      mendUserId: string,
      sessionId: string,
      lifecycle: ThreadLifecycle | null,
      receipt?: LifecycleReceipt,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Keeps how a person's settle, snooze, pin or order command was answered, by its id. */
    readonly keepLifecycleReceipt: (
      mendUserId: string,
      receipt: LifecycleReceipt,
    ) => Effect.Effect<void, GatewayStateError>;
    /** How a person's settle, snooze, pin or order command was answered, if it was. */
    readonly lifecycleReceipt: (
      mendUserId: string,
      commandId: string,
    ) => Effect.Effect<Option.Option<LifecycleReceipt>, GatewayStateError>;
    /** Session id → the person's settle, snooze, pin and order of its thread. */
    readonly listLifecycles: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyMap<string, ThreadLifecycle>, GatewayStateError>;
    /** Keeps when a person last saw a thread (ISO), or, for null, lets go of it. */
    readonly setVisited: (
      mendUserId: string,
      sessionId: string,
      at: string | null,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Session id → when the person last saw its thread. */
    readonly listVisited: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyMap<string, string>, GatewayStateError>;
    /**
     * The model and reasoning effort a person chose for a session's next launch, written together:
     * an absent field stays as it is, null clears it.
     */
    readonly setNextChoices: (
      mendUserId: string,
      sessionId: string,
      choices: NextChoices,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Every next-launch effort a person chose, by session. */
    readonly listNextEfforts: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyMap<string, string>, GatewayStateError>;
    /** A person's model favorites, hidden models and model order; unset until a client sets them. */
    readonly modelPreferences: (
      mendUserId: string,
    ) => Effect.Effect<KeptModelPreferences, GatewayStateError>;
    /**
     * Replaces a person's model preferences with `change` of the kept ones and counts the write,
     * read and written in one step, so two clients' changes never lose one another. Answers what
     * was kept.
     */
    readonly updateModelPreferences: <E>(
      mendUserId: string,
      change: (current: ModelPreferences) => Result.Result<ModelPreferences, E>,
    ) => Effect.Effect<KeptModelPreferences, GatewayStateError | E>;
    /** Every next-launch model a person chose, by session. */
    readonly listNextModels: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyMap<string, string>, GatewayStateError>;
    /** Keeps the project actions a person saved for a project, or, for null, lets go of them. */
    readonly setProjectScripts: (
      mendUserId: string,
      projectId: string,
      scripts: ReadonlyArray<ProjectScript> | null,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Project id → the project actions the person saved for it. */
    readonly listProjectScripts: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<ProjectScript>>, GatewayStateError>;
    /** Every bearer neither revoked nor expired at `now`: what a start checks with Mend. */
    readonly liveSessions: (
      now: number,
    ) => Effect.Effect<ReadonlyArray<BearerSession>, GatewayStateError>;
    /** The people who have a message kept that can still reach Mend: their hubs start with the gateway. */
    readonly peopleWithQueuedMessages: () => Effect.Effect<
      ReadonlyArray<BearerSession>,
      GatewayStateError
    >;
  }
>()("@mend/t3-gateway/GatewayState") {}

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Migrations by `PRAGMA user_version`. Append only. t3code shows Mend's projects and sessions by
 * their Mend ids, except a thread a t3code client launched, which keeps the client's own id for
 * the person who launched it: `thread_ids` maps it to its session, per person, with the launch's
 * command and options (migration 4). Everyone else sees the session by its Mend id.
 * `project_ids` stays empty. `message_ids` and `run_ids` carry the ids of every turn a t3code
 * client sent, keyed by the Mend turn: a message id comes from the client, so it is never a key
 * across sessions, and a recorded turn is never replaced (migration 3). `pending_removals` keeps
 * each person's deleted sessions that Mend keeps until their workspace has stopped (migration 5).
 * `queued_messages` and `queue_holds` keep each person's queues (migration 6): a message names its
 * sender by bearer session, never by device token. `images` keeps the images a person attached
 * (migration 7), and a kept message names its images by id. `next_modes` keeps the permission mode
 * a person chose for a session's next launch (migration 8). `archived_threads` keeps the threads
 * a person archived in t3code (migration 9): Mend has no archive, so it is the person's view alone.
 * `thread_lifecycles` keeps the threads a person settled or snoozed in t3code (migration 10), the
 * same way. `thread_visits` keeps when a person last saw each thread (migration 11), what t3code's
 * unread marker reads, and `next_efforts` the reasoning effort a person chose for a session's next
 * launch (migration 12), as `next_modes` keeps the mode. `model_preferences` keeps a person's model
 * favorites, hidden models and model order (migration 13), and `next_models` the model a person
 * chose for a session's next launch, as `next_efforts` keeps the effort (migration 14).
 * `thread_lifecycles` gains a person's pin, pin order, Active order, auto-settle opt-out and last
 * snooze wake (migration 15).
 * Migration 16 adds `source-control:write` to every stored grant that holds the five scopes the
 * gateway granted while it withheld that one. Those pairings asked for t3code's standard set or
 * for the default grant, and lost the scope only because the gateway did not back it yet. A
 * pairing made after migration 16 that asks for exactly those five keeps them as asked, which a
 * rule applied on every read could not tell apart.
 * A kept launch's opening message names the new worktree it waits for and whether preparing that
 * worktree failed, and `queue_preparations` keeps a session's worktree preparation with the shell
 * its setup script runs in (migration 17), so a restart keeps t3code's retry and the retry can stop
 * that shell. `project_scripts` keeps the project actions a person saved in t3code (migration 17):
 * the only setup scripts the gateway runs.
 * `thread_lifecycles` gained the id of the client command that last changed each row (migration 18),
 * which kept only the latest: an older command sent again after a newer one applied again.
 * `lifecycle_receipts` replaces it (migration 19): how each of a person's settle, snooze, pin and
 * order commands was answered, by command id, kept as t3code keeps its command receipts and let go
 * of with the thread.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE bearer_sessions (
    session_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    device_token TEXT NOT NULL,
    mend_user_id TEXT NOT NULL,
    mend_user_name TEXT NOT NULL,
    mend_user_email TEXT NOT NULL,
    mend_device_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    client_label TEXT,
    client_device_type TEXT NOT NULL,
    client_os TEXT,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE project_ids (
    project_id TEXT PRIMARY KEY,
    mend_project_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE thread_ids (
    thread_id TEXT PRIMARY KEY,
    mend_session_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE message_ids (
    message_id TEXT PRIMARY KEY,
    mend_session_id TEXT NOT NULL,
    mend_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (mend_session_id, mend_ref)
  );
  `,
  `
  CREATE TABLE run_ids (
    run_id TEXT PRIMARY KEY,
    mend_session_id TEXT NOT NULL,
    mend_turn_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE message_ids_by_turn (
    mend_session_id TEXT NOT NULL,
    mend_ref TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (mend_session_id, mend_ref)
  );
  INSERT OR IGNORE INTO message_ids_by_turn (mend_session_id, mend_ref, message_id, created_at)
    SELECT mend_session_id, mend_ref, message_id, created_at FROM message_ids;
  DROP TABLE message_ids;
  ALTER TABLE message_ids_by_turn RENAME TO message_ids;
  `,
  `
  DROP TABLE thread_ids;
  CREATE TABLE thread_ids (
    mend_user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    launch_options TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (mend_user_id, thread_id),
    UNIQUE (mend_user_id, mend_session_id),
    UNIQUE (mend_user_id, command_id)
  );
  `,
  `
  CREATE TABLE pending_removals (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
  `
  CREATE TABLE queued_messages (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    text TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    sender_session_id TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    launches INTEGER NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id, position)
  );
  CREATE TABLE queue_holds (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
  `
  CREATE TABLE images (
    image_id TEXT PRIMARY KEY,
    mend_user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    placed_session_id TEXT,
    placed_process_id TEXT,
    mend_path TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX images_by_person ON images (mend_user_id, message_id);
  CREATE TABLE sent_images (
    mend_user_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    image_id TEXT NOT NULL,
    mend_path TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, message_id, position)
  );
  CREATE INDEX sent_images_by_image ON sent_images (image_id);
  ALTER TABLE queued_messages ADD COLUMN image_ids TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE next_modes (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
  `
  CREATE TABLE archived_threads (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
  `
  CREATE TABLE thread_lifecycles (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    settled_override TEXT,
    settled_at TEXT,
    unsettled_at TEXT,
    snoozed_until TEXT,
    snoozed_at TEXT,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
  `
  CREATE TABLE thread_visits (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    last_visited_at TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
  `
  CREATE TABLE next_efforts (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    effort TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
  `
  CREATE TABLE model_preferences (
    mend_user_id TEXT PRIMARY KEY,
    favorites TEXT,
    provider_model_preferences TEXT,
    version INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE next_models (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
  `
  ALTER TABLE thread_lifecycles ADD COLUMN pinned_at TEXT;
  ALTER TABLE thread_lifecycles ADD COLUMN pin_order_key TEXT;
  ALTER TABLE thread_lifecycles ADD COLUMN active_order_key TEXT;
  ALTER TABLE thread_lifecycles ADD COLUMN auto_settle_disabled_at TEXT;
  ALTER TABLE thread_lifecycles ADD COLUMN last_snooze_wake_at TEXT;
  `,
  `
  UPDATE bearer_sessions
  SET scopes = json_insert(scopes, '$[#]', 'source-control:write')
  WHERE NOT EXISTS (
      SELECT 1 FROM json_each(bearer_sessions.scopes) WHERE value = 'source-control:write'
    )
    AND (
      SELECT count(DISTINCT value) FROM json_each(bearer_sessions.scopes)
      WHERE value IN ('orchestration:read', 'orchestration:operate', 'terminal:read',
                      'terminal:operate', 'filesystem:read')
    ) = 5;
  `,
  `
  ALTER TABLE queued_messages ADD COLUMN workspace_preparation TEXT;
  ALTER TABLE queued_messages ADD COLUMN preparation_failed INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE queue_preparations (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    setup_process_id TEXT,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  CREATE TABLE project_scripts (
    mend_user_id TEXT NOT NULL,
    mend_project_id TEXT NOT NULL,
    scripts TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_project_id)
  );
  `,
  `
  ALTER TABLE thread_lifecycles ADD COLUMN last_command_id TEXT;
  `,
  `
  ALTER TABLE thread_lifecycles DROP COLUMN last_command_id;
  CREATE TABLE lifecycle_receipts (
    mend_user_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    sequence INTEGER,
    refusal TEXT,
    PRIMARY KEY (mend_user_id, command_id),
    CHECK ((sequence IS NULL) <> (refusal IS NULL))
  );
  CREATE INDEX lifecycle_receipts_by_session ON lifecycle_receipts (mend_user_id, mend_session_id);
  `,
  `
  CREATE TABLE steer_messages (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    client_steer_id TEXT NOT NULL,
    sender_session_id TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id, client_steer_id)
  );
  CREATE TABLE sent_steers (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    client_steer_id TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id, client_steer_id)
  );
  `,
];

/** The gateway's sequence high-water mark in `meta` (`reserveSequences`). */
const SEQUENCE_HIGH = "sequence_high";

const UserVersionRow = Schema.Struct({ user_version: Schema.Number });
const MetaRow = Schema.Struct({ value: Schema.String });
const Scopes = Schema.fromJsonString(Schema.Array(AuthEnvironmentScope));
const SessionRow = Schema.Struct({
  session_id: AuthSessionId,
  token_hash: Schema.String,
  device_token: Schema.String,
  mend_user_id: Schema.String,
  mend_user_name: Schema.String,
  mend_user_email: Schema.String,
  mend_device_id: Schema.String,
  scopes: Scopes,
  client_label: Schema.NullOr(Schema.String),
  client_device_type: AuthClientMetadataDeviceType,
  client_os: Schema.NullOr(Schema.String),
  issued_at: Schema.Number,
  expires_at: Schema.Number,
  revoked_at: Schema.NullOr(Schema.Number),
});
const decodeSessionRow = Schema.decodeUnknownEffect(SessionRow);
const TurnIdsRow = Schema.Struct({
  session_id: Schema.String,
  turn_id: Schema.String,
  run_id: Schema.String,
  message_id: Schema.String,
});
const decodeTurnIdsRows = Schema.decodeUnknownEffect(Schema.Array(TurnIdsRow));
const encodeScopes = Schema.encodeSync(Scopes);
const LaunchOptionsJson = Schema.fromJsonString(ThreadLaunchOptions);
const encodeLaunchOptions = Schema.encodeSync(LaunchOptionsJson);
const ThreadRow = Schema.Struct({
  thread_id: Schema.String,
  mend_session_id: Schema.String,
  command_id: Schema.String,
  launch_options: LaunchOptionsJson,
});
const decodeThreadRows = Schema.decodeUnknownEffect(Schema.Array(ThreadRow));
const RemovalRow = Schema.Struct({ mend_session_id: Schema.String });
const decodeRemovalRows = Schema.decodeUnknownEffect(Schema.Array(RemovalRow));
const StoredSteer = Schema.Struct({
  clientSteerId: Schema.String.check(Schema.isUUID()),
  messageId: Schema.String,
  runId: Schema.String,
  targetTurnId: Schema.String,
  targetRunId: Schema.String,
  text: Schema.String,
  imageIds: Schema.Array(Schema.String),
  requestedAt: Schema.String,
  sender: Schema.String,
  author: Schema.String,
  intent: Schema.Literals(["steer", "promoted_queued_to_steer"]),
  promotion: Schema.NullOr(
    Schema.Struct({
      successors: Schema.Array(Schema.String),
      entry: Schema.Struct({
        runId: Schema.String,
        messageId: Schema.String,
        text: Schema.String,
        requestedAt: Schema.String,
        sender: Schema.String,
        state: Schema.Literal("queued"),
        error: Schema.NullOr(Schema.String),
        launches: Schema.Number,
        imageIds: Schema.Array(Schema.String),
        workspacePreparation: Schema.Null,
        preparationFailed: Schema.Boolean,
      }),
    }),
  ),
  phase: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("preparing") }),
    Schema.Struct({
      kind: Schema.Literal("posting"),
      input: Schema.String,
      images: Schema.Array(Schema.Struct({ imageId: Schema.String, path: Schema.String })),
      processId: Schema.NullOr(Schema.String),
      unconfirmed: Schema.Int,
    }),
    Schema.Struct({
      kind: Schema.Literal("observed"),
      input: Schema.String,
      images: Schema.Array(Schema.Struct({ imageId: Schema.String, path: Schema.String })),
      processId: Schema.NullOr(Schema.String),
      receipt: MendTurnSteer,
    }),
  ]),
});
const SentSteerRecord = Schema.Struct({
  clientSteerId: Schema.String,
  messageId: Schema.String,
  runId: Schema.String,
  targetTurnId: Schema.String,
  targetRunId: Schema.String,
  text: Schema.String,
  imageIds: Schema.Array(Schema.String),
  intent: Schema.Literals(["steer", "promoted_queued_to_steer"]),
  requestedAt: Schema.String,
  outcome: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("sent") }),
    Schema.Struct({ kind: Schema.Literal("queued"), turnId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("returned") }),
  ]),
});
const decodeSentSteerRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      mend_session_id: Schema.String,
      record: Schema.fromJsonString(SentSteerRecord),
    }),
  ),
);
const decodeSteerRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      mend_session_id: Schema.String,
      record: Schema.fromJsonString(StoredSteer),
      device_token: Schema.NullOr(Schema.String),
    }),
  ),
);

const QueuedRow = Schema.Struct({
  mend_session_id: Schema.String,
  run_id: Schema.String,
  message_id: Schema.String,
  text: Schema.String,
  requested_at: Schema.String,
  sender_session_id: Schema.String,
  state: Schema.Literals(["preparing", "queued", "launching", "sending", "failed", "cancelled"]),
  error: Schema.NullOr(Schema.String),
  launches: Schema.Number,
  image_ids: Schema.fromJsonString(Schema.Array(Schema.String)),
  workspace_preparation: Schema.NullOr(
    Schema.fromJsonString(OrchestrationV2ThreadLaunchWorkspaceStrategy),
  ),
  preparation_failed: Schema.Number,
  /** The sender's device token while their bearer is live; null once revoked or gone. */
  device_token: Schema.NullOr(Schema.String),
});
const decodeQueuedRows = Schema.decodeUnknownEffect(Schema.Array(QueuedRow));
const HoldRow = Schema.Struct({ mend_session_id: Schema.String });
const decodeHoldRows = Schema.decodeUnknownEffect(Schema.Array(HoldRow));
const PreparationRow = Schema.Struct({
  mend_session_id: Schema.String,
  status: Schema.Literals(["running", "failed"]),
  setup_process_id: Schema.NullOr(Schema.String),
});
const decodePreparationRows = Schema.decodeUnknownEffect(Schema.Array(PreparationRow));
const ProjectScriptsRow = Schema.Struct({
  mend_project_id: Schema.String,
  scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
});
const decodeProjectScriptsRows = Schema.decodeUnknownEffect(Schema.Array(ProjectScriptsRow));
const encodeProjectScripts = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeSessionRows = Schema.decodeUnknownEffect(Schema.Array(SessionRow));
const encodeImageIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeWorkspacePreparation = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationV2ThreadLaunchWorkspaceStrategy),
);
const ImageRow = Schema.Struct({
  image_id: Schema.String,
  thread_id: Schema.String,
  message_id: Schema.String,
  position: Schema.Number,
  name: Schema.String,
  mime_type: Schema.String,
  size_bytes: Schema.Number,
  placed_session_id: Schema.NullOr(Schema.String),
  placed_process_id: Schema.NullOr(Schema.String),
  mend_path: Schema.NullOr(Schema.String),
});
const decodeImageRows = Schema.decodeUnknownEffect(Schema.Array(ImageRow));
const ModeRow = Schema.Struct({
  mend_session_id: Schema.String,
  permission_mode: Schema.Literals(["bypass", "ask"]),
});
const decodeModeRows = Schema.decodeUnknownEffect(Schema.Array(ModeRow));
const ArchivedRow = Schema.Struct({ mend_session_id: Schema.String, archived_at: Schema.String });
const decodeArchivedRows = Schema.decodeUnknownEffect(Schema.Array(ArchivedRow));
const VisitedRow = Schema.Struct({
  mend_session_id: Schema.String,
  last_visited_at: Schema.String,
});
const decodeVisitedRows = Schema.decodeUnknownEffect(Schema.Array(VisitedRow));
const EffortRow = Schema.Struct({ mend_session_id: Schema.String, effort: Schema.String });
const decodeEffortRows = Schema.decodeUnknownEffect(Schema.Array(EffortRow));
const ModelRow = Schema.Struct({ mend_session_id: Schema.String, model: Schema.String });
const decodeModelRows = Schema.decodeUnknownEffect(Schema.Array(ModelRow));
const LifecycleRow = Schema.Struct({
  mend_session_id: Schema.String,
  settled_override: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settled_at: Schema.NullOr(Schema.String),
  unsettled_at: Schema.NullOr(Schema.String),
  snoozed_until: Schema.NullOr(Schema.String),
  snoozed_at: Schema.NullOr(Schema.String),
  pinned_at: Schema.NullOr(Schema.String),
  pin_order_key: Schema.NullOr(Schema.String),
  active_order_key: Schema.NullOr(Schema.String),
  auto_settle_disabled_at: Schema.NullOr(Schema.String),
  last_snooze_wake_at: Schema.NullOr(Schema.String),
});
const decodeLifecycleRows = Schema.decodeUnknownEffect(Schema.Array(LifecycleRow));
const LifecycleReceiptRow = Schema.Union([
  Schema.Struct({
    command_id: Schema.String,
    mend_session_id: Schema.String,
    sequence: Schema.Number,
    refusal: Schema.Null,
  }),
  Schema.Struct({
    command_id: Schema.String,
    mend_session_id: Schema.String,
    sequence: Schema.Null,
    refusal: Schema.String,
  }),
]);
const decodeLifecycleReceiptRow = Schema.decodeUnknownEffect(LifecycleReceiptRow);
const ModelPreferencesRow = Schema.Struct({
  favorites: Schema.NullOr(Schema.fromJsonString(ModelFavorites)),
  provider_model_preferences: Schema.NullOr(Schema.fromJsonString(ProviderModelPreferences)),
});
const decodeModelPreferencesRow = Schema.decodeUnknownResult(ModelPreferencesRow);
const decodeModelPreferencesVersion = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.Number }),
);
const encodeModelPreferencesRow = Schema.encodeSync(ModelPreferencesRow);
interface ModelPreferencesRead {
  readonly version: number;
  readonly kept: Result.Result<ModelPreferences, Schema.SchemaError>;
}
const keptOrNone = (
  mendUserId: string,
  { version, kept }: ModelPreferencesRead,
): Effect.Effect<KeptModelPreferences> =>
  Result.isSuccess(kept)
    ? Effect.succeed({ version, preferences: kept.success })
    : Effect.logWarning("t3 gateway set aside model preferences it can no longer read", {
        mendUserId,
        cause: kept.failure,
      }).pipe(Effect.as({ version, preferences: NO_MODEL_PREFERENCES }));
const ImageBytesRow = Schema.Struct({ ...ImageRow.fields, bytes: Schema.Uint8Array });
const decodeImageBytesRow = Schema.decodeUnknownEffect(ImageBytesRow);
const storedImageOf = (row: typeof ImageRow.Type): StoredImage => ({
  id: row.image_id,
  threadId: row.thread_id,
  messageId: row.message_id,
  position: row.position,
  name: row.name,
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
  placement:
    row.placed_session_id === null || row.placed_process_id === null || row.mend_path === null
      ? null
      : { sessionId: row.placed_session_id, processId: row.placed_process_id, path: row.mend_path },
});
const SentImageRow = Schema.Struct({
  message_id: Schema.String,
  image_id: Schema.String,
  mend_path: Schema.String,
});
const decodeSentImageRows = Schema.decodeUnknownEffect(Schema.Array(SentImageRow));
const ImageIdRow = Schema.Struct({ image_id: Schema.String });
const decodeImageIdRows = Schema.decodeUnknownEffect(Schema.Array(ImageIdRow));

const toBearerSession = (decoded: typeof SessionRow.Type): BearerSession => ({
  sessionId: decoded.session_id,
  tokenHash: decoded.token_hash,
  deviceToken: decoded.device_token,
  mendUser: {
    id: decoded.mend_user_id,
    name: decoded.mend_user_name,
    email: decoded.mend_user_email,
  },
  mendDeviceId: decoded.mend_device_id,
  scopes: decoded.scopes,
  client: {
    label: decoded.client_label,
    deviceType: decoded.client_device_type,
    os: decoded.client_os,
  },
  issuedAt: decoded.issued_at,
  expiresAt: decoded.expires_at,
  revokedAt: decoded.revoked_at,
});

const migrate = (database: DatabaseSync): void => {
  const row = Schema.decodeUnknownSync(UserVersionRow)(
    database.prepare("PRAGMA user_version").get(),
  );
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version];
    if (migration === undefined) break;
    database.exec("BEGIN");
    try {
      database.exec(migration);
      database.exec(`PRAGMA user_version = ${version + 1}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
};

const ensureEnvironmentId = (database: DatabaseSync): string => {
  database
    .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('environment_id', ?)")
    .run(randomUUID());
  return Schema.decodeUnknownSync(MetaRow)(
    database.prepare("SELECT value FROM meta WHERE key = 'environment_id'").get(),
  ).value;
};

/**
 * The state file 0600, before SQLite opens it, and a directory the gateway creates 0700. A file an
 * older gateway created with the umask's mode is narrowed on open, and so are SQLite's `-wal` and
 * `-shm` beside it (SQLite creates those with the database file's mode). An existing directory is
 * left as it is: `MEND_T3_GATEWAY_STATE_PATH` may name a directory others use.
 */
const restrictStateFile = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
};

/** Opens (or creates) the state file at `path`, migrated, and closes it with the scope. */
export const openGatewayState = (
  path: string,
): Effect.Effect<GatewayState["Service"], GatewayStateError, Scope.Scope> =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (path !== ":memory:") restrictStateFile(path);
          const opened = new DatabaseSync(path);
          opened.exec("PRAGMA journal_mode = WAL");
          opened.exec("PRAGMA foreign_keys = ON");
          return opened;
        },
        catch: (cause) => new GatewayStateError({ operation: "open", cause }),
      }),
      (opened) => Effect.sync(() => opened.close()),
    );
    const environmentId = yield* Effect.try({
      try: () => {
        migrate(database);
        return EnvironmentId.make(ensureEnvironmentId(database));
      },
      catch: (cause) => new GatewayStateError({ operation: "migrate", cause }),
    });

    const run = <A>(operation: string, f: () => A): Effect.Effect<A, GatewayStateError> =>
      Effect.try({ try: f, catch: (cause) => new GatewayStateError({ operation, cause }) });

    const transaction = (operation: string, f: () => void) =>
      run(operation, () => {
        database.exec("BEGIN");
        try {
          f();
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });

    const insertSession = (session: BearerSession) =>
      run("insertSession", () => {
        database
          .prepare(
            `INSERT INTO bearer_sessions (
               session_id, token_hash, device_token, mend_user_id, mend_user_name, mend_user_email,
               mend_device_id, scopes, client_label, client_device_type, client_os, issued_at,
               expires_at, revoked_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            session.sessionId,
            session.tokenHash,
            session.deviceToken,
            session.mendUser.id,
            session.mendUser.name,
            session.mendUser.email,
            session.mendDeviceId,
            encodeScopes(session.scopes),
            session.client.label,
            session.client.deviceType,
            session.client.os,
            session.issuedAt,
            session.expiresAt,
            session.revokedAt,
          );
      });

    const findOne = (operation: string, query: string, key: string) =>
      run(operation, () => database.prepare(query).get(key)).pipe(
        Effect.flatMap((row) =>
          row === undefined
            ? Effect.succeed(Option.none<BearerSession>())
            : decodeSessionRow(row).pipe(
                Effect.mapError((cause) => new GatewayStateError({ operation, cause })),
                Effect.map((decoded) => Option.some(toBearerSession(decoded))),
              ),
        ),
      );

    const findSession = (tokenHash: string) =>
      findOne("findSession", "SELECT * FROM bearer_sessions WHERE token_hash = ?", tokenHash);

    const findSessionById = (sessionId: AuthSessionId) =>
      findOne("findSessionById", "SELECT * FROM bearer_sessions WHERE session_id = ?", sessionId);

    const revokeSession = (sessionId: AuthSessionId, at: number) =>
      run("revokeSession", () => {
        database
          .prepare(
            "UPDATE bearer_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
          )
          .run(at, sessionId);
      });

    const revokeSessionsForDevice = (deviceToken: string, at: number) =>
      run("revokeSessionsForDevice", () => {
        database
          .prepare(
            "UPDATE bearer_sessions SET revoked_at = ? WHERE device_token = ? AND revoked_at IS NULL",
          )
          .run(at, deviceToken);
      });
    const recordTurnIds = (ids: TurnIds, at: number) =>
      run("recordTurnIds", () => {
        database.exec("BEGIN");
        try {
          database
            .prepare(
              `INSERT OR IGNORE INTO run_ids (run_id, mend_session_id, mend_turn_id, created_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(ids.runId, ids.sessionId, ids.turnId, at);
          database
            .prepare(
              `INSERT OR IGNORE INTO message_ids (message_id, mend_session_id, mend_ref, created_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(ids.messageId, ids.sessionId, ids.turnId, at);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });

    const listTurnIds = () =>
      run("listTurnIds", () =>
        database
          .prepare(
            `SELECT r.mend_session_id AS session_id, r.mend_turn_id AS turn_id, r.run_id AS run_id,
                    m.message_id AS message_id
               FROM run_ids r
               JOIN message_ids m ON m.mend_session_id = r.mend_session_id AND m.mend_ref = r.mend_turn_id`,
          )
          .all(),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeTurnIdsRows(rows).pipe(
            Effect.mapError((cause) => new GatewayStateError({ operation: "listTurnIds", cause })),
          ),
        ),
        Effect.map((rows) =>
          rows.map(
            (row): TurnIds => ({
              sessionId: row.session_id,
              turnId: row.turn_id,
              runId: row.run_id,
              messageId: row.message_id,
            }),
          ),
        ),
      );

    const recordThread = (mendUserId: string, thread: LaunchedThread, at: number) =>
      run("recordThread", () => {
        database
          .prepare(
            `INSERT OR IGNORE INTO thread_ids
               (mend_user_id, thread_id, mend_session_id, command_id, launch_options, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            mendUserId,
            thread.threadId,
            thread.sessionId,
            thread.commandId,
            encodeLaunchOptions(thread.options),
            at,
          );
      });

    const listThreads = (mendUserId: string) =>
      run("listThreads", () =>
        database
          .prepare(
            `SELECT thread_id, mend_session_id, command_id, launch_options FROM thread_ids
              WHERE mend_user_id = ? ORDER BY created_at`,
          )
          .all(mendUserId),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeThreadRows(rows).pipe(
            Effect.mapError((cause) => new GatewayStateError({ operation: "listThreads", cause })),
          ),
        ),
        Effect.map((rows) =>
          rows.map(
            (row): LaunchedThread => ({
              threadId: row.thread_id,
              sessionId: row.mend_session_id,
              commandId: row.command_id,
              options: row.launch_options,
            }),
          ),
        ),
      );

    const forgetThread = (mendUserId: string, sessionId: string) =>
      transaction("forgetThread", () => {
        for (const table of ["thread_ids", "lifecycle_receipts", "steer_messages", "sent_steers"]) {
          database
            .prepare(`DELETE FROM ${table} WHERE mend_user_id = ? AND mend_session_id = ?`)
            .run(mendUserId, sessionId);
        }
      });

    const keepRemoval = (mendUserId: string, sessionId: string, at: number) =>
      run("keepRemoval", () => {
        database
          .prepare(
            `INSERT OR IGNORE INTO pending_removals (mend_user_id, mend_session_id, deleted_at)
             VALUES (?, ?, ?)`,
          )
          .run(mendUserId, sessionId, at);
      });

    const listRemovals = (mendUserId: string) =>
      run("listRemovals", () =>
        database
          .prepare("SELECT mend_session_id FROM pending_removals WHERE mend_user_id = ?")
          .all(mendUserId),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeRemovalRows(rows).pipe(
            Effect.mapError((cause) => new GatewayStateError({ operation: "listRemovals", cause })),
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.mend_session_id)),
      );

    const dropRemoval = (mendUserId: string, sessionId: string) =>
      run("dropRemoval", () => {
        database
          .prepare("DELETE FROM pending_removals WHERE mend_user_id = ? AND mend_session_id = ?")
          .run(mendUserId, sessionId);
      });

    const saveQueue = (
      mendUserId: string,
      sessionId: string,
      queue: StoredQueue,
      sent: ReadonlyMap<string, SentSteer | null> = new Map(),
    ) =>
      transaction("saveQueue", () => {
        database
          .prepare("DELETE FROM queued_messages WHERE mend_user_id = ? AND mend_session_id = ?")
          .run(mendUserId, sessionId);
        database
          .prepare("DELETE FROM queue_holds WHERE mend_user_id = ? AND mend_session_id = ?")
          .run(mendUserId, sessionId);
        database
          .prepare("DELETE FROM queue_preparations WHERE mend_user_id = ? AND mend_session_id = ?")
          .run(mendUserId, sessionId);
        const insert = database.prepare(
          `INSERT INTO queued_messages (
             mend_user_id, mend_session_id, position, run_id, message_id, text, requested_at,
             sender_session_id, state, error, launches, image_ids, workspace_preparation,
             preparation_failed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        queue.entries.forEach((entry, position) => {
          insert.run(
            mendUserId,
            sessionId,
            position,
            entry.runId,
            entry.messageId,
            entry.text,
            entry.requestedAt,
            entry.sender,
            entry.state,
            entry.error,
            entry.launches,
            encodeImageIds(entry.imageIds),
            entry.workspacePreparation === null
              ? null
              : encodeWorkspacePreparation(entry.workspacePreparation),
            entry.preparationFailed ? 1 : 0,
          );
        });
        database
          .prepare("DELETE FROM steer_messages WHERE mend_user_id = ? AND mend_session_id = ?")
          .run(mendUserId, sessionId);
        const insertSteer = database.prepare(
          "INSERT INTO steer_messages (mend_user_id, mend_session_id, client_steer_id, sender_session_id, record) VALUES (?, ?, ?, ?, ?)",
        );
        for (const steer of queue.steers ?? []) {
          insertSteer.run(
            mendUserId,
            sessionId,
            steer.clientSteerId,
            steer.sender,
            JSON.stringify(steer),
          );
        }
        const keepSent = database.prepare(
          "INSERT OR REPLACE INTO sent_steers (mend_user_id, mend_session_id, client_steer_id, record) VALUES (?, ?, ?, ?)",
        );
        const forgetSent = database.prepare(
          "DELETE FROM sent_steers WHERE mend_user_id = ? AND mend_session_id = ? AND client_steer_id = ?",
        );
        for (const [clientSteerId, steer] of sent) {
          if (steer === null) forgetSent.run(mendUserId, sessionId, clientSteerId);
          else keepSent.run(mendUserId, sessionId, clientSteerId, JSON.stringify(steer));
        }
        if (queue.held) {
          database
            .prepare("INSERT INTO queue_holds (mend_user_id, mend_session_id) VALUES (?, ?)")
            .run(mendUserId, sessionId);
        }
        if (queue.preparation !== null) {
          database
            .prepare(
              `INSERT INTO queue_preparations (mend_user_id, mend_session_id, status, setup_process_id)
               VALUES (?, ?, ?, ?)`,
            )
            .run(mendUserId, sessionId, queue.preparation.status, queue.preparation.setupProcessId);
        }
      });

    const decoded =
      <A>(operation: string, decode: (rows: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
      (rows: unknown) =>
        decode(rows).pipe(Effect.mapError((cause) => new GatewayStateError({ operation, cause })));

    const loadQueues = (mendUserId: string) =>
      Effect.gen(function* () {
        const rows = yield* run("loadQueues", () =>
          database
            .prepare(
              `SELECT q.mend_session_id, q.run_id, q.message_id, q.text, q.requested_at,
                      q.sender_session_id, q.state, q.error, q.launches, q.image_ids,
                      q.workspace_preparation, q.preparation_failed,
                      CASE WHEN b.revoked_at IS NULL THEN b.device_token END AS device_token
                 FROM queued_messages q
                 LEFT JOIN bearer_sessions b ON b.session_id = q.sender_session_id
                WHERE q.mend_user_id = ?
                ORDER BY q.mend_session_id, q.position`,
            )
            .all(mendUserId),
        ).pipe(Effect.flatMap(decoded("loadQueues", decodeQueuedRows)));
        const steerRows = yield* run("loadQueues", () =>
          database
            .prepare(
              `SELECT s.mend_session_id, s.record,
                  CASE WHEN b.revoked_at IS NULL THEN b.device_token END AS device_token
             FROM steer_messages s LEFT JOIN bearer_sessions b ON b.session_id = s.sender_session_id
            WHERE s.mend_user_id = ?`,
            )
            .all(mendUserId),
        ).pipe(Effect.flatMap(decoded("loadQueues", decodeSteerRows)));
        const holds = yield* run("loadQueues", () =>
          database
            .prepare("SELECT mend_session_id FROM queue_holds WHERE mend_user_id = ?")
            .all(mendUserId),
        ).pipe(Effect.flatMap(decoded("loadQueues", decodeHoldRows)));
        const held = new Set(holds.map((row) => row.mend_session_id));
        const preparationRows = yield* run("loadQueues", () =>
          database
            .prepare(
              "SELECT mend_session_id, status, setup_process_id FROM queue_preparations WHERE mend_user_id = ?",
            )
            .all(mendUserId),
        ).pipe(Effect.flatMap(decoded("loadQueues", decodePreparationRows)));
        const preparations = new Map(
          preparationRows.map(
            (row) =>
              [
                row.mend_session_id,
                { status: row.status, setupProcessId: row.setup_process_id },
              ] as const,
          ),
        );
        const bySession = new Map<
          string,
          { entries: Array<StoredEntry>; senders: Map<string, string> }
        >();
        for (const row of rows) {
          const fresh: { entries: Array<StoredEntry>; senders: Map<string, string> } = {
            entries: [],
            senders: new Map(),
          };
          const kept = bySession.get(row.mend_session_id) ?? fresh;
          const state: EntryState = row.state;
          kept.entries.push({
            runId: row.run_id,
            messageId: row.message_id,
            text: row.text,
            requestedAt: row.requested_at,
            sender: row.sender_session_id,
            state,
            error: row.error,
            launches: row.launches,
            imageIds: row.image_ids,
            workspacePreparation:
              row.workspace_preparation?.type === "worktree" ? row.workspace_preparation : null,
            preparationFailed: row.preparation_failed !== 0,
          });
          if (row.device_token !== null) kept.senders.set(row.sender_session_id, row.device_token);
          bySession.set(row.mend_session_id, kept);
        }
        for (const sessionId of [...held, ...preparations.keys()]) {
          if (!bySession.has(sessionId))
            bySession.set(sessionId, { entries: [], senders: new Map() });
        }
        const steers = new Map<string, Array<SteerRecord>>();
        for (const row of steerRows) {
          const records = steers.get(row.mend_session_id) ?? [];
          records.push(row.record);
          steers.set(row.mend_session_id, records);
          const kept = bySession.get(row.mend_session_id) ?? {
            entries: [],
            senders: new Map<string, string>(),
          };
          if (row.device_token !== null) kept.senders.set(row.record.sender, row.device_token);
          bySession.set(row.mend_session_id, kept);
        }
        return Array.from(bySession, ([sessionId, kept]) => ({
          sessionId,
          queue: {
            held: held.has(sessionId),
            preparation: preparations.get(sessionId) ?? null,
            entries: kept.entries,
            steers: steers.get(sessionId) ?? [],
          },
          senders: kept.senders,
        }));
      });

    const listSentSteers = (mendUserId: string) =>
      run("listSentSteers", () =>
        database
          .prepare("SELECT mend_session_id, record FROM sent_steers WHERE mend_user_id = ?")
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listSentSteers", decodeSentSteerRows)),
        Effect.map((rows) =>
          rows.map((row) => ({ sessionId: row.mend_session_id, steer: row.record })),
        ),
      );

    const reserveSequences = (from: number, count: number) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        run("reserveSequences", () => {
          database.exec("BEGIN IMMEDIATE");
          try {
            const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(SEQUENCE_HIGH);
            const high =
              row === undefined ? now : Number(Schema.decodeUnknownSync(MetaRow)(row).value);
            const start = Math.max(high, from);
            database
              .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
              .run(SEQUENCE_HIGH, String(start + count));
            database.exec("COMMIT");
            return start;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        }),
      );

    const saveImages = (
      mendUserId: string,
      images: ReadonlyArray<StoredImage & { readonly bytes: Uint8Array }>,
      at: number,
    ) =>
      transaction("saveImages", () => {
        const insert = database.prepare(
          `INSERT OR REPLACE INTO images (
             image_id, mend_user_id, thread_id, message_id, position, name, mime_type, size_bytes,
             bytes, placed_session_id, placed_process_id, mend_path, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const image of images) {
          insert.run(
            image.id,
            mendUserId,
            image.threadId,
            image.messageId,
            image.position,
            image.name,
            image.mimeType,
            image.sizeBytes,
            image.bytes,
            image.placement?.sessionId ?? null,
            image.placement?.processId ?? null,
            image.placement?.path ?? null,
            at,
          );
        }
      });

    const IMAGE_COLUMNS =
      "image_id, thread_id, message_id, position, name, mime_type, size_bytes, placed_session_id, placed_process_id, mend_path";

    const listImages = (mendUserId: string) =>
      run("listImages", () =>
        database
          .prepare(
            `SELECT ${IMAGE_COLUMNS} FROM images WHERE mend_user_id = ? ORDER BY message_id, position`,
          )
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listImages", decodeImageRows)),
        Effect.map((rows) => rows.map(storedImageOf)),
      );

    const imageBytes = (mendUserId: string, imageId: string) =>
      run("imageBytes", () =>
        database
          .prepare(
            `SELECT ${IMAGE_COLUMNS}, bytes FROM images WHERE mend_user_id = ? AND image_id = ?`,
          )
          .get(mendUserId, imageId),
      ).pipe(
        Effect.flatMap((row) =>
          row === undefined
            ? Effect.succeed(null)
            : decoded(
                "imageBytes",
                decodeImageBytesRow,
              )(row).pipe(
                Effect.map((decodedRow) => ({
                  image: storedImageOf(decodedRow),
                  bytes: decodedRow.bytes,
                })),
              ),
        ),
      );

    const recordImagePlacement = (mendUserId: string, imageId: string, placement: ImagePlacement) =>
      run("recordImagePlacement", () => {
        database
          .prepare(
            `UPDATE images SET placed_session_id = ?, placed_process_id = ?, mend_path = ?
              WHERE mend_user_id = ? AND image_id = ?`,
          )
          .run(placement.sessionId, placement.processId, placement.path, mendUserId, imageId);
      });

    const recordSentImages = (
      mendUserId: string,
      messageId: string,
      images: ReadonlyArray<SentImage>,
    ) =>
      transaction("recordSentImages", () => {
        database
          .prepare("DELETE FROM sent_images WHERE mend_user_id = ? AND message_id = ?")
          .run(mendUserId, messageId);
        const insert = database.prepare(
          `INSERT INTO sent_images (mend_user_id, message_id, position, image_id, mend_path)
           VALUES (?, ?, ?, ?, ?)`,
        );
        images.forEach((image, position) => {
          insert.run(mendUserId, messageId, position, image.imageId, image.path);
        });
      });

    const listSentImages = (mendUserId: string) =>
      run("listSentImages", () =>
        database
          .prepare(
            `SELECT message_id, image_id, mend_path FROM sent_images
              WHERE mend_user_id = ? ORDER BY message_id, position`,
          )
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listSentImages", decodeSentImageRows)),
        Effect.map((rows) => {
          const byMessage = new Map<string, Array<SentImage>>();
          for (const row of rows) {
            const sent = byMessage.get(row.message_id) ?? [];
            sent.push({ imageId: row.image_id, path: row.mend_path });
            byMessage.set(row.message_id, sent);
          }
          const answer: ReadonlyMap<string, ReadonlyArray<SentImage>> = byMessage;
          return answer;
        }),
      );

    const pruneImages = (before: number, mendUserId: string | null) =>
      run("pruneImages", () =>
        database
          .prepare(
            `DELETE FROM images
              WHERE created_at < ? AND (? IS NULL OR mend_user_id = ?)
                AND NOT EXISTS (SELECT 1 FROM sent_images s WHERE s.image_id = images.image_id)
                AND NOT EXISTS (
                  SELECT 1 FROM steer_messages s, json_each(s.record, '$.imageIds') j
                   WHERE s.mend_user_id = images.mend_user_id AND j.value = images.image_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM sent_steers s, json_each(s.record, '$.imageIds') j
                   WHERE s.mend_user_id = images.mend_user_id AND j.value = images.image_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM queued_messages q, json_each(q.image_ids) j
                   WHERE q.mend_user_id = images.mend_user_id AND j.value = images.image_id
                )
              RETURNING image_id`,
          )
          .all(before, mendUserId, mendUserId),
      ).pipe(
        Effect.flatMap(decoded("pruneImages", decodeImageIdRows)),
        Effect.map((rows) => rows.map((row) => row.image_id)),
      );

    const setNextMode = (mendUserId: string, sessionId: string, mode: "bypass" | "ask" | null) =>
      run("setNextMode", () => {
        if (mode === null) {
          database
            .prepare("DELETE FROM next_modes WHERE mend_user_id = ? AND mend_session_id = ?")
            .run(mendUserId, sessionId);
          return;
        }
        database
          .prepare(
            "INSERT OR REPLACE INTO next_modes (mend_user_id, mend_session_id, permission_mode) VALUES (?, ?, ?)",
          )
          .run(mendUserId, sessionId, mode);
      });

    const listNextModes = (mendUserId: string) =>
      run("listNextModes", () =>
        database
          .prepare("SELECT mend_session_id, permission_mode FROM next_modes WHERE mend_user_id = ?")
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listNextModes", decodeModeRows)),
        Effect.map(
          (rows): ReadonlyMap<string, "bypass" | "ask"> =>
            new Map(rows.map((row) => [row.mend_session_id, row.permission_mode] as const)),
        ),
      );

    const setArchived = (mendUserId: string, sessionId: string, at: string | null) =>
      run("setArchived", () => {
        if (at === null) {
          database
            .prepare("DELETE FROM archived_threads WHERE mend_user_id = ? AND mend_session_id = ?")
            .run(mendUserId, sessionId);
          return;
        }
        database
          .prepare(
            "INSERT OR REPLACE INTO archived_threads (mend_user_id, mend_session_id, archived_at) VALUES (?, ?, ?)",
          )
          .run(mendUserId, sessionId, at);
      });

    const listArchived = (mendUserId: string) =>
      run("listArchived", () =>
        database
          .prepare(
            "SELECT mend_session_id, archived_at FROM archived_threads WHERE mend_user_id = ?",
          )
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listArchived", decodeArchivedRows)),
        Effect.map(
          (rows): ReadonlyMap<string, string> =>
            new Map(rows.map((row) => [row.mend_session_id, row.archived_at] as const)),
        ),
      );

    const writeLifecycleReceipt = (mendUserId: string, receipt: LifecycleReceipt) => {
      database
        .prepare(
          `INSERT OR REPLACE INTO lifecycle_receipts
            (mend_user_id, command_id, mend_session_id, sequence, refusal)
            VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          mendUserId,
          receipt.commandId,
          receipt.sessionId,
          receipt.answer._tag === "Applied" ? receipt.answer.sequence : null,
          receipt.answer._tag === "Refused" ? receipt.answer.reason : null,
        );
    };

    const setLifecycle = (
      mendUserId: string,
      sessionId: string,
      lifecycle: ThreadLifecycle | null,
      receipt?: LifecycleReceipt,
    ) =>
      transaction("setLifecycle", () => {
        if (receipt !== undefined) writeLifecycleReceipt(mendUserId, receipt);
        if (lifecycle === null) {
          database
            .prepare("DELETE FROM thread_lifecycles WHERE mend_user_id = ? AND mend_session_id = ?")
            .run(mendUserId, sessionId);
          return;
        }
        database
          .prepare(
            `INSERT OR REPLACE INTO thread_lifecycles
              (mend_user_id, mend_session_id, settled_override, settled_at, unsettled_at, snoozed_until,
                snoozed_at, pinned_at, pin_order_key, active_order_key, auto_settle_disabled_at,
                last_snooze_wake_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            mendUserId,
            sessionId,
            lifecycle.settledOverride,
            lifecycle.settledAt,
            lifecycle.unsettledAt,
            lifecycle.snoozedUntil,
            lifecycle.snoozedAt,
            lifecycle.pinnedAt,
            lifecycle.pinOrderKey,
            lifecycle.activeOrderKey,
            lifecycle.autoSettleDisabledAt,
            lifecycle.lastSnoozeWakeAt,
          );
      });

    const keepLifecycleReceipt = (mendUserId: string, receipt: LifecycleReceipt) =>
      run("keepLifecycleReceipt", () => writeLifecycleReceipt(mendUserId, receipt));

    const lifecycleReceipt = (mendUserId: string, commandId: string) =>
      run("lifecycleReceipt", () =>
        database
          .prepare(
            `SELECT command_id, mend_session_id, sequence, refusal
              FROM lifecycle_receipts WHERE mend_user_id = ? AND command_id = ?`,
          )
          .get(mendUserId, commandId),
      ).pipe(
        Effect.flatMap((row) =>
          row === undefined
            ? Effect.succeedNone
            : decodeLifecycleReceiptRow(row).pipe(
                Effect.mapError(
                  (cause) => new GatewayStateError({ operation: "lifecycleReceipt", cause }),
                ),
                Effect.map(
                  (receipt): Option.Option<LifecycleReceipt> =>
                    Option.some({
                      commandId: receipt.command_id,
                      sessionId: receipt.mend_session_id,
                      answer:
                        receipt.refusal === null
                          ? { _tag: "Applied", sequence: receipt.sequence }
                          : { _tag: "Refused", reason: receipt.refusal },
                    }),
                ),
              ),
        ),
      );

    const listLifecycles = (mendUserId: string) =>
      run("listLifecycles", () =>
        database
          .prepare(
            `SELECT mend_session_id, settled_override, settled_at, unsettled_at, snoozed_until, snoozed_at,
                pinned_at, pin_order_key, active_order_key, auto_settle_disabled_at, last_snooze_wake_at
              FROM thread_lifecycles WHERE mend_user_id = ?`,
          )
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listLifecycles", decodeLifecycleRows)),
        Effect.map(
          (rows): ReadonlyMap<string, ThreadLifecycle> =>
            new Map(
              rows.map(
                (row) =>
                  [
                    row.mend_session_id,
                    {
                      settledOverride: row.settled_override,
                      settledAt: row.settled_at,
                      unsettledAt: row.unsettled_at,
                      snoozedUntil: row.snoozed_until,
                      snoozedAt: row.snoozed_at,
                      pinnedAt: row.pinned_at,
                      pinOrderKey: row.pin_order_key,
                      activeOrderKey: row.active_order_key,
                      autoSettleDisabledAt: row.auto_settle_disabled_at,
                      lastSnoozeWakeAt: row.last_snooze_wake_at,
                    },
                  ] as const,
              ),
            ),
        ),
      );

    const setVisited = (mendUserId: string, sessionId: string, at: string | null) =>
      run("setVisited", () => {
        if (at === null) {
          database
            .prepare("DELETE FROM thread_visits WHERE mend_user_id = ? AND mend_session_id = ?")
            .run(mendUserId, sessionId);
          return;
        }
        database
          .prepare(
            "INSERT OR REPLACE INTO thread_visits (mend_user_id, mend_session_id, last_visited_at) VALUES (?, ?, ?)",
          )
          .run(mendUserId, sessionId, at);
      });

    const listVisited = (mendUserId: string) =>
      run("listVisited", () =>
        database
          .prepare(
            "SELECT mend_session_id, last_visited_at FROM thread_visits WHERE mend_user_id = ?",
          )
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listVisited", decodeVisitedRows)),
        Effect.map(
          (rows): ReadonlyMap<string, string> =>
            new Map(rows.map((row) => [row.mend_session_id, row.last_visited_at] as const)),
        ),
      );

    const setNextChoices = (mendUserId: string, sessionId: string, choices: NextChoices) =>
      transaction("setNextChoices", () => {
        const write = (table: "next_models" | "next_efforts", column: "model" | "effort") => {
          const value = choices[column];
          if (value === undefined) return;
          if (value === null) {
            database
              .prepare(`DELETE FROM ${table} WHERE mend_user_id = ? AND mend_session_id = ?`)
              .run(mendUserId, sessionId);
            return;
          }
          database
            .prepare(
              `INSERT OR REPLACE INTO ${table} (mend_user_id, mend_session_id, ${column}) VALUES (?, ?, ?)`,
            )
            .run(mendUserId, sessionId, value);
        };
        write("next_models", "model");
        write("next_efforts", "effort");
      });

    const setProjectScripts = (
      mendUserId: string,
      projectId: string,
      scripts: ReadonlyArray<ProjectScript> | null,
    ) =>
      Effect.gen(function* () {
        if (scripts === null) {
          return yield* run("setProjectScripts", () => {
            database
              .prepare("DELETE FROM project_scripts WHERE mend_user_id = ? AND mend_project_id = ?")
              .run(mendUserId, projectId);
          });
        }
        const encoded = yield* encodeProjectScripts(scripts).pipe(
          Effect.mapError(
            (cause) => new GatewayStateError({ operation: "setProjectScripts", cause }),
          ),
        );
        yield* run("setProjectScripts", () => {
          database
            .prepare(
              "INSERT OR REPLACE INTO project_scripts (mend_user_id, mend_project_id, scripts) VALUES (?, ?, ?)",
            )
            .run(mendUserId, projectId, encoded);
        });
      });

    const listProjectScripts = (mendUserId: string) =>
      run("listProjectScripts", () =>
        database
          .prepare("SELECT mend_project_id, scripts FROM project_scripts WHERE mend_user_id = ?")
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listProjectScripts", decodeProjectScriptsRows)),
        Effect.map(
          (rows): ReadonlyMap<string, ReadonlyArray<ProjectScript>> =>
            new Map(rows.map((row) => [row.mend_project_id, row.scripts] as const)),
        ),
      );

    const listNextEfforts = (mendUserId: string) =>
      run("listNextEfforts", () =>
        database
          .prepare("SELECT mend_session_id, effort FROM next_efforts WHERE mend_user_id = ?")
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listNextEfforts", decodeEffortRows)),
        Effect.map(
          (rows): ReadonlyMap<string, string> =>
            new Map(rows.map((row) => [row.mend_session_id, row.effort] as const)),
        ),
      );

    const readModelPreferences = (mendUserId: string): ModelPreferencesRead => {
      const row = database
        .prepare(
          "SELECT favorites, provider_model_preferences, version FROM model_preferences WHERE mend_user_id = ?",
        )
        .get(mendUserId);
      if (row === undefined) return { version: 0, kept: Result.succeed(NO_MODEL_PREFERENCES) };
      return {
        version: decodeModelPreferencesVersion(row).version,
        kept: Result.map(decodeModelPreferencesRow(row), (kept) => ({
          favorites: kept.favorites,
          providerModelPreferences: kept.provider_model_preferences,
        })),
      };
    };

    const modelPreferences = (mendUserId: string) =>
      run("modelPreferences", () => readModelPreferences(mendUserId)).pipe(
        Effect.flatMap((kept) => keptOrNone(mendUserId, kept)),
      );

    const updateModelPreferences = <E>(
      mendUserId: string,
      change: (current: ModelPreferences) => Result.Result<ModelPreferences, E>,
    ) =>
      run("updateModelPreferences", () => {
        const read = readModelPreferences(mendUserId);
        const version = read.version + 1;
        const next = change(Result.getOrElse(read.kept, () => NO_MODEL_PREFERENCES));
        if (Result.isSuccess(next)) {
          const row = encodeModelPreferencesRow({
            favorites: next.success.favorites,
            provider_model_preferences: next.success.providerModelPreferences,
          });
          database
            .prepare(
              "INSERT OR REPLACE INTO model_preferences (mend_user_id, favorites, provider_model_preferences, version) VALUES (?, ?, ?, ?)",
            )
            .run(mendUserId, row.favorites, row.provider_model_preferences, version);
        }
        return { read, version, next };
      }).pipe(
        Effect.tap(({ read }) => keptOrNone(mendUserId, read)),
        Effect.flatMap(({ version, next }) =>
          Effect.map(Effect.fromResult(next), (preferences) => ({ version, preferences })),
        ),
      );

    const listNextModels = (mendUserId: string) =>
      run("listNextModels", () =>
        database
          .prepare("SELECT mend_session_id, model FROM next_models WHERE mend_user_id = ?")
          .all(mendUserId),
      ).pipe(
        Effect.flatMap(decoded("listNextModels", decodeModelRows)),
        Effect.map(
          (rows): ReadonlyMap<string, string> =>
            new Map(rows.map((row) => [row.mend_session_id, row.model] as const)),
        ),
      );

    const liveSessions = (now: number) =>
      run("liveSessions", () =>
        database
          .prepare("SELECT * FROM bearer_sessions WHERE revoked_at IS NULL AND expires_at > ?")
          .all(now),
      ).pipe(
        Effect.flatMap(decoded("liveSessions", decodeSessionRows)),
        Effect.map((rows) => rows.map(toBearerSession)),
      );

    const peopleWithQueuedMessages = () =>
      run("peopleWithQueuedMessages", () =>
        database
          .prepare(
            `SELECT b.* FROM bearer_sessions b
               JOIN (SELECT DISTINCT q.mend_user_id, q.sender_session_id FROM queued_messages q
                      WHERE q.state IN ('queued', 'launching')
                      UNION SELECT s.mend_user_id, s.sender_session_id FROM steer_messages s) p
                 ON p.sender_session_id = b.session_id AND p.mend_user_id = b.mend_user_id
              WHERE b.revoked_at IS NULL`,
          )
          .all(),
      ).pipe(
        Effect.flatMap(decoded("peopleWithQueuedMessages", decodeSessionRows)),
        Effect.map((rows) => rows.map(toBearerSession)),
      );

    return {
      environmentId,
      insertSession,
      findSession,
      findSessionById,
      revokeSession,
      revokeSessionsForDevice,
      recordTurnIds,
      listTurnIds,
      recordThread,
      listThreads,
      forgetThread,
      keepRemoval,
      listRemovals,
      dropRemoval,
      saveQueue,
      loadQueues,
      listSentSteers,
      reserveSequences,
      saveImages,
      listImages,
      imageBytes,
      recordImagePlacement,
      recordSentImages,
      listSentImages,
      pruneImages,
      setNextMode,
      listNextModes,
      setArchived,
      listArchived,
      setLifecycle,
      keepLifecycleReceipt,
      lifecycleReceipt,
      listLifecycles,
      setVisited,
      listVisited,
      setNextChoices,
      listNextEfforts,
      modelPreferences,
      updateModelPreferences,
      listNextModels,
      setProjectScripts,
      listProjectScripts,
      liveSessions,
      peopleWithQueuedMessages,
    };
  });

/** The state file at the configured path. */
export const GatewayStateLive: Layer.Layer<GatewayState, GatewayStateError, GatewayConfig> =
  Layer.effect(
    GatewayState,
    Effect.gen(function* () {
      const config = yield* GatewayConfig;
      return yield* openGatewayState(config.statePath);
    }),
  );
