import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { WorktreeId } from "@mend/domain";
import {
  HarnessLayout,
  HarnessLayoutSource,
  LINUX_UID_FIRST,
  LINUX_UID_RANGE,
  LinuxIdentity,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { uniqueViolationConstraint } from "./unique-violation.ts";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * The login name Mend proposes for an account (docs/adr/0016, decision 1): `m` and 8 base32
 * characters of a hash of its id. `attempt` 0 is every account's first proposal; a later attempt
 * is asked only when that name is already another account's, and is stable for the same
 * (account, attempt), so the allocation is deterministic.
 */
export const linuxLoginNameOf = (accountId: string, attempt = 0): string => {
  const digest = createHash("sha256")
    .update(attempt === 0 ? accountId : `${accountId}\u0000${attempt}`)
    .digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < 8) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === 8) break;
  }
  return `m${out}`;
};

/** How many names an allocation tries before it gives up (each a distinct hash). */
const NAME_ATTEMPTS = 16;

const IdentityRow = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  uid: Schema.Number,
});
const decodeIdentityRow = Schema.decodeUnknownSync(IdentityRow);
const identityOf = (row: unknown): LinuxIdentity => {
  const decoded = decodeIdentityRow(row);
  return new LinuxIdentity({ accountId: decoded.userId, name: decoded.name, uid: decoded.uid });
};

/** One launch's layout, as recorded before its executor was created. */
export interface ExecutorLayoutRecord {
  readonly launchId: string;
  readonly worktreeId: WorktreeId;
  readonly sessionId: string;
  readonly layout: HarnessLayout;
  readonly source: HarnessLayoutSource;
  /** Why, in the words the session line takes; null when nothing needs saying. */
  readonly reason: string | null;
  /** The image the decision read the capability of; null when none was read. */
  readonly imageKey: string | null;
  /** Prepare found the executor runs this layout (or recorded the fallback). */
  readonly confirmed: boolean;
}

const LaunchRow = Schema.Struct({
  launchId: Schema.String,
  worktreeId: WorktreeId,
  sessionId: Schema.String,
  layout: HarnessLayout,
  source: HarnessLayoutSource,
  reason: Schema.NullOr(Schema.String),
  imageKey: Schema.NullOr(Schema.String),
  confirmed: Schema.Boolean,
});
const decodeLaunchRow = Schema.decodeUnknownSync(LaunchRow);

/** What a worktree's row says about its layout (decision 14). */
export interface WorktreeLayoutRecord {
  /** `person` once it has had a person launch; never cleared. */
  readonly layout: "person" | null;
  /** The operator-only `harnessLayout` the start that made it asked for. */
  readonly requested: HarnessLayout | null;
}

const WorktreeLayoutRow = Schema.Struct({
  layout: Schema.NullOr(Schema.Literal("person")),
  requested: Schema.NullOr(HarnessLayout),
});
const decodeWorktreeLayoutRow = Schema.decodeUnknownSync(WorktreeLayoutRow);

/** What an executor's prepare found about an image on a runtime (decision 1). */
export interface ImageLayoutCapabilityRecord {
  readonly imageKey: string;
  readonly runtime: string;
  /** The executor could run the person layout. */
  readonly person: boolean;
  /** What it lacked, each in a word the refusal line names (`sudo`, `uid 40001 is taken`, …). */
  readonly missing: ReadonlyArray<string>;
  readonly observedAt: Date;
}

const CapabilityRow = Schema.Struct({
  imageKey: Schema.String,
  runtime: Schema.String,
  person: Schema.Boolean,
  missing: Schema.Array(Schema.String),
  observedAt: Schema.Date,
});
const decodeCapabilityRow = Schema.decodeUnknownSync(CapabilityRow);

/** A conversation moved into its owner's shared directory (docs/adr/0016, decision 6). */
export interface SharedConversationRecord {
  readonly owner: string;
  readonly movedAt: Date;
}

/** Who holds a conversation's one live agent process (docs/adr/0016, decision 6). */
export interface ConversationHolder {
  /** The launch of the executor the process runs in; null once released. */
  readonly launchId: string | null;
  /** The process, once bound; null while its start runs. */
  readonly processId: string | null;
  readonly fence: number;
}

/**
 * A take of a conversation's one live agent process: `taken` with the fence a bind must name, or
 * held by another start or a process the platform has not reported exited.
 */
export type ConversationTake =
  | { readonly taken: true; readonly fence: number }
  | {
      readonly taken: false;
      readonly launchId: string | null;
      readonly processId: string | null;
    };

/** A start that took a conversation and never bound a process is taken as gone after this. */
export const CONVERSATION_TAKE_STALE_MS = 2 * 60_000;

const HolderRow = Schema.Struct({
  launchId: Schema.NullOr(Schema.String),
  processId: Schema.NullOr(Schema.String),
  fence: Schema.Union([Schema.Number, Schema.String]),
});
const decodeHolderRow = Schema.decodeUnknownSync(HolderRow);
const holderOf = (row: unknown): ConversationHolder => {
  const decoded = decodeHolderRow(row);
  return { launchId: decoded.launchId, processId: decoded.processId, fence: Number(decoded.fence) };
};

export class LinuxIdentityExhaustedError extends Schema.TaggedErrorClass<LinuxIdentityExhaustedError>()(
  "LinuxIdentityExhaustedError",
  { accountId: Schema.String, message: Schema.String },
) {}

/**
 * Per-person harness homes (docs/adr/0016), in Postgres: Linux identities, the layout of each
 * worktree and launch, and what Mend learnt about each image. Read and written only by the
 * session engine's layout step; nothing here runs unless `MEND_HARNESS_LAYOUT` or a worktree's
 * record asks for the person layout, apart from the worktree record every launch reads.
 */
export class HarnessLayoutsRepo extends Context.Service<
  HarnessLayoutsRepo,
  {
    /** The account's identity, allocating it the first time: a stable name and uid. */
    readonly ensureIdentity: (
      accountId: string,
    ) => Effect.Effect<LinuxIdentity, LinuxIdentityExhaustedError>;
    /** The identities these accounts already have; an account without one is left out. */
    readonly identitiesOf: (
      accountIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LinuxIdentity>>;
    /**
     * The identities with these login names (a home is `/home/<name>`): whose a home Core lists
     * is, when its person runs nothing Mend could name them by.
     */
    readonly identitiesNamed: (
      names: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LinuxIdentity>>;
    /** The worktree's layout record; both fields null for a worktree with none. */
    readonly worktreeLayout: (worktreeId: WorktreeId) => Effect.Effect<WorktreeLayoutRecord>;
    /** The operator's `harnessLayout`, on the start that made the worktree. */
    readonly requestLayout: (worktreeId: WorktreeId, layout: HarnessLayout) => Effect.Effect<void>;
    /** A launch's decision, recorded before its executor is created; idempotent per launch. */
    readonly recordLaunch: (record: ExecutorLayoutRecord) => Effect.Effect<void>;
    /**
     * Prepare found the launch's executor runs the person layout: the launch is confirmed and,
     * in the same transaction, the worktree becomes `person` for good.
     */
    readonly confirmPerson: (launchId: string, worktreeId: WorktreeId) => Effect.Effect<void>;
    /**
     * Prepare found the launch's executor cannot run the person layout it was predicted on, on a
     * worktree with no layout: the launch is `shared`, from `fallback`.
     */
    readonly recordFallback: (launchId: string, reason: string) => Effect.Effect<void>;
    /** A shared launch's prepare ran: nothing to correct, the decision stands. */
    readonly confirm: (launchId: string) => Effect.Effect<void>;
    readonly launchLayout: (launchId: string) => Effect.Effect<ExecutorLayoutRecord | null>;
    /**
     * Whether any launch or worktree has a layout recorded at all: a person launch, a person
     * worktree, or an operator's `harnessLayout`. Read once at startup: with the flag off and
     * nothing recorded, every launch is `shared` and nothing here is read again (docs/adr/0016).
     */
    readonly anyRecorded: () => Effect.Effect<boolean>;
    readonly capabilityOf: (
      imageKey: string,
      runtime: string,
    ) => Effect.Effect<ImageLayoutCapabilityRecord | null>;
    readonly recordCapability: (
      record: Omit<ImageLayoutCapabilityRecord, "observedAt">,
    ) => Effect.Effect<void>;
    /**
     * A session's conversation moved into its owner's shared directory (decision 6): once shared
     * from now on, until the session ends. Idempotent: the first move's record stays.
     */
    readonly markConversationShared: (sessionId: string, owner: string) => Effect.Effect<void>;
    /** The record of a session's move into `C`; null for a conversation never shared. */
    readonly sharedConversationOf: (
      sessionId: string,
    ) => Effect.Effect<SharedConversationRecord | null>;
    /**
     * Take a conversation's one live agent process for a start in `launchId` (decision 6): taken
     * when nothing holds it, when its holder was released, when the process it names has exited,
     * or when a start took it and bound nothing for `CONVERSATION_TAKE_STALE_MS`. Every take grows
     * the fence. Otherwise held: a process the platform has not reported exited is still the
     * conversation's, an unreachable executor included, and nobody starts a second.
     */
    readonly takeConversation: (
      sessionId: string,
      launchId: string,
    ) => Effect.Effect<ConversationTake>;
    /** The started process, bound to the take whose fence it names; false when fenced out. */
    readonly bindConversation: (
      sessionId: string,
      fence: number,
      processId: string,
    ) => Effect.Effect<boolean>;
    /**
     * Release a conversation: by the process the platform reported exited, or by the fence of a
     * start that ended before it bound one. A newer take is never released by an older one.
     */
    readonly releaseConversation: (
      sessionId: string,
      by: { readonly processId: string } | { readonly fence: number },
    ) => Effect.Effect<void>;
    /** An executor ended: every conversation its launch held is released. */
    readonly releaseConversationsOfLaunch: (launchId: string) => Effect.Effect<void>;
    readonly conversationHolder: (sessionId: string) => Effect.Effect<ConversationHolder | null>;
  }
>()("@mend/db/HarnessLayoutsRepo") {}

export const HarnessLayoutsRepoLive: Layer.Layer<HarnessLayoutsRepo, never, PgClient.PgClient> =
  Layer.effect(
    HarnessLayoutsRepo,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const identityRow = (accountId: string) =>
        sql`
          SELECT user_id AS "userId", name, uid FROM linux_identities
          WHERE user_id = ${accountId}`.pipe(
          Effect.orDie,
          Effect.map((rows) => (rows[0] === undefined ? null : identityOf(rows[0]))),
        );

      const ensureIdentity = Effect.fn("HarnessLayoutsRepo.ensureIdentity")(function* (
        accountId: string,
      ) {
        const existing = yield* identityRow(accountId);
        if (existing !== null) return existing;
        // Concurrent first runs of different accounts race for the same next uid; the loser of
        // the unique key asks again. A name another account holds moves on to the next proposal.
        for (let attempt = 0, races = 0; attempt < NAME_ATTEMPTS && races < 64; ) {
          const name = linuxLoginNameOf(accountId, attempt);
          const inserted = yield* sql`
            INSERT INTO linux_identities (user_id, name, uid)
            SELECT ${accountId}, ${name}, COALESCE(MAX(uid), ${LINUX_UID_FIRST - 1}) + 1
              FROM linux_identities
            ON CONFLICT (user_id) DO NOTHING
            RETURNING user_id AS "userId", name, uid`.pipe(
            Effect.map((rows) => ({ rows, violated: null })),
            Effect.catch((error) =>
              Effect.succeed({ rows: [], violated: uniqueViolationConstraint(error) ?? "other" }),
            ),
          );
          if (inserted.rows[0] !== undefined) return identityOf(inserted.rows[0]);
          const now = yield* identityRow(accountId);
          if (now !== null) return now;
          if (inserted.violated === "other") {
            return yield* new LinuxIdentityExhaustedError({
              accountId,
              message: `no uid left in ${LINUX_UID_RANGE.first}–${LINUX_UID_RANGE.last}`,
            });
          }
          if (inserted.violated === "linux_identities_name_key") attempt++;
          else races++;
        }
        return yield* new LinuxIdentityExhaustedError({
          accountId,
          message: "no Linux login name could be allocated",
        });
      });

      const identitiesOf = Effect.fn("HarnessLayoutsRepo.identitiesOf")(function* (
        accountIds: ReadonlyArray<string>,
      ) {
        if (accountIds.length === 0) return [];
        const rows = yield* sql`
          SELECT user_id AS "userId", name, uid FROM linux_identities
          WHERE user_id IN ${sql.in([...accountIds])}
          ORDER BY uid`.pipe(Effect.orDie);
        return rows.map(identityOf);
      });

      const identitiesNamed = Effect.fn("HarnessLayoutsRepo.identitiesNamed")(function* (
        names: ReadonlyArray<string>,
      ) {
        if (names.length === 0) return [];
        const rows = yield* sql`
          SELECT user_id AS "userId", name, uid FROM linux_identities
          WHERE name IN ${sql.in([...names])}
          ORDER BY uid`.pipe(Effect.orDie);
        return rows.map(identityOf);
      });

      const worktreeLayout = Effect.fn("HarnessLayoutsRepo.worktreeLayout")(function* (
        worktreeId: WorktreeId,
      ) {
        const rows = yield* sql`
          SELECT harness_layout AS layout, harness_layout_requested AS requested
          FROM worktrees WHERE id = ${worktreeId}`.pipe(Effect.orDie);
        return rows[0] === undefined
          ? { layout: null, requested: null }
          : decodeWorktreeLayoutRow(rows[0]);
      });

      const requestLayout = Effect.fn("HarnessLayoutsRepo.requestLayout")(function* (
        worktreeId: WorktreeId,
        layout: HarnessLayout,
      ) {
        yield* sql`
          UPDATE worktrees SET harness_layout_requested = ${layout}
          WHERE id = ${worktreeId}`.pipe(Effect.orDie);
      });

      const recordLaunch = Effect.fn("HarnessLayoutsRepo.recordLaunch")(function* (
        record: ExecutorLayoutRecord,
      ) {
        yield* sql`
          INSERT INTO executor_layouts
            (launch_id, worktree_id, session_id, layout, source, reason, image_key, confirmed)
          VALUES (${record.launchId}, ${record.worktreeId}, ${record.sessionId}, ${record.layout},
                  ${record.source}, ${record.reason}, ${record.imageKey}, ${record.confirmed})
          ON CONFLICT (launch_id) DO UPDATE
            SET layout = excluded.layout, source = excluded.source, reason = excluded.reason,
                image_key = excluded.image_key, confirmed = excluded.confirmed,
                updated_at = now()
            WHERE NOT executor_layouts.confirmed`.pipe(Effect.orDie);
        if (record.layout === "person" && record.confirmed) {
          yield* sql`
            UPDATE worktrees SET harness_layout = 'person'
            WHERE id = ${record.worktreeId} AND harness_layout IS NULL`.pipe(Effect.orDie);
        }
      });

      const confirmPerson = Effect.fn("HarnessLayoutsRepo.confirmPerson")(function* (
        launchId: string,
        worktreeId: WorktreeId,
      ) {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE executor_layouts SET confirmed = true, updated_at = now()
                WHERE launch_id = ${launchId} AND layout = 'person'`;
              yield* sql`
                UPDATE worktrees SET harness_layout = 'person'
                WHERE id = ${worktreeId} AND harness_layout IS NULL`;
            }),
          )
          .pipe(Effect.orDie);
      });

      const recordFallback = Effect.fn("HarnessLayoutsRepo.recordFallback")(function* (
        launchId: string,
        reason: string,
      ) {
        yield* sql`
          UPDATE executor_layouts
             SET layout = 'shared', source = 'fallback', reason = ${reason}, confirmed = true,
                 updated_at = now()
           WHERE launch_id = ${launchId} AND NOT confirmed`.pipe(Effect.orDie);
      });

      const confirm = Effect.fn("HarnessLayoutsRepo.confirm")(function* (launchId: string) {
        yield* sql`
          UPDATE executor_layouts SET confirmed = true, updated_at = now()
          WHERE launch_id = ${launchId} AND layout = 'shared'`.pipe(Effect.orDie);
      });

      const launchLayout = Effect.fn("HarnessLayoutsRepo.launchLayout")(function* (
        launchId: string,
      ) {
        const rows = yield* sql`
          SELECT launch_id AS "launchId", worktree_id AS "worktreeId", session_id AS "sessionId",
                 layout, source, reason, image_key AS "imageKey", confirmed
          FROM executor_layouts WHERE launch_id = ${launchId}`.pipe(Effect.orDie);
        if (rows[0] === undefined) return null;
        return decodeLaunchRow(rows[0]);
      });

      const capabilityOf = Effect.fn("HarnessLayoutsRepo.capabilityOf")(function* (
        imageKey: string,
        runtime: string,
      ) {
        const rows = yield* sql`
          SELECT image_key AS "imageKey", runtime, person, missing, observed_at AS "observedAt"
          FROM image_layout_capabilities
          WHERE image_key = ${imageKey} AND runtime = ${runtime}`.pipe(Effect.orDie);
        return rows[0] === undefined ? null : decodeCapabilityRow(rows[0]);
      });

      const recordCapability = Effect.fn("HarnessLayoutsRepo.recordCapability")(function* (
        record: Omit<ImageLayoutCapabilityRecord, "observedAt">,
      ) {
        yield* sql`
          INSERT INTO image_layout_capabilities (image_key, runtime, person, missing)
          VALUES (${record.imageKey}, ${record.runtime}, ${record.person},
                  ${JSON.stringify(record.missing)}::jsonb)
          ON CONFLICT (image_key, runtime) DO UPDATE
            SET person = excluded.person, missing = excluded.missing, observed_at = now()`.pipe(
          Effect.orDie,
        );
      });

      const anyRecorded = Effect.fn("HarnessLayoutsRepo.anyRecorded")(function* () {
        const rows = yield* sql<{ readonly recorded: boolean }>`
          SELECT EXISTS (SELECT 1 FROM executor_layouts WHERE layout = 'person')
              OR EXISTS (SELECT 1 FROM worktrees
                         WHERE harness_layout IS NOT NULL OR harness_layout_requested IS NOT NULL)
              AS recorded`.pipe(Effect.orDie);
        return rows[0]?.recorded === true;
      });

      const markConversationShared = Effect.fn("HarnessLayoutsRepo.markConversationShared")(
        function* (sessionId: string, owner: string) {
          yield* sql`
            INSERT INTO shared_conversations (session_id, owner_user_id)
            VALUES (${sessionId}, ${owner})
            ON CONFLICT (session_id) DO NOTHING`.pipe(Effect.orDie);
        },
      );

      const sharedConversationOf = Effect.fn("HarnessLayoutsRepo.sharedConversationOf")(function* (
        sessionId: string,
      ) {
        const rows = yield* sql<{ readonly owner: string; readonly movedAt: Date }>`
            SELECT owner_user_id AS owner, moved_at AS "movedAt"
            FROM shared_conversations WHERE session_id = ${sessionId}`.pipe(Effect.orDie);
        const row = rows[0];
        return row === undefined ? null : { owner: row.owner, movedAt: new Date(row.movedAt) };
      });

      const conversationHolder = Effect.fn("HarnessLayoutsRepo.conversationHolder")(function* (
        sessionId: string,
      ) {
        const rows = yield* sql`
          SELECT launch_id AS "launchId", process_id AS "processId", fence
          FROM conversation_processes WHERE session_id = ${sessionId}`.pipe(Effect.orDie);
        return rows[0] === undefined ? null : holderOf(rows[0]);
      });

      const takeConversation = Effect.fn("HarnessLayoutsRepo.takeConversation")(function* (
        sessionId: string,
        launchId: string,
      ) {
        const staleSeconds = CONVERSATION_TAKE_STALE_MS / 1000;
        const rows = yield* sql<{ readonly fence: number | string }>`
          INSERT INTO conversation_processes (session_id, launch_id, process_id, fence)
          VALUES (${sessionId}, ${launchId}, NULL, 1)
          ON CONFLICT (session_id) DO UPDATE
            SET launch_id = excluded.launch_id, process_id = NULL,
                fence = conversation_processes.fence + 1, taken_at = now()
            WHERE conversation_processes.launch_id IS NULL
               OR (conversation_processes.process_id IS NULL
                   AND conversation_processes.taken_at < now() - make_interval(secs => ${staleSeconds}))
               OR (conversation_processes.process_id IS NOT NULL AND EXISTS (
                     SELECT 1 FROM session_processes p
                     WHERE p.id = conversation_processes.process_id AND p.exited_at IS NOT NULL))
          RETURNING fence`.pipe(Effect.orDie);
        const taken = rows[0];
        if (taken !== undefined) return { taken: true, fence: Number(taken.fence) } as const;
        const holder = yield* conversationHolder(sessionId);
        return {
          taken: false,
          launchId: holder?.launchId ?? null,
          processId: holder?.processId ?? null,
        } as const;
      });

      const bindConversation = Effect.fn("HarnessLayoutsRepo.bindConversation")(function* (
        sessionId: string,
        fence: number,
        processId: string,
      ) {
        const rows = yield* sql`
          UPDATE conversation_processes SET process_id = ${processId}
          WHERE session_id = ${sessionId} AND fence = ${fence} AND launch_id IS NOT NULL
          RETURNING session_id`.pipe(Effect.orDie);
        return rows.length > 0;
      });

      const releaseConversation = Effect.fn("HarnessLayoutsRepo.releaseConversation")(function* (
        sessionId: string,
        by: { readonly processId: string } | { readonly fence: number },
      ) {
        if ("processId" in by) {
          yield* sql`
            UPDATE conversation_processes SET launch_id = NULL, process_id = NULL
            WHERE session_id = ${sessionId} AND process_id = ${by.processId}`.pipe(Effect.orDie);
          return;
        }
        yield* sql`
          UPDATE conversation_processes SET launch_id = NULL, process_id = NULL
          WHERE session_id = ${sessionId} AND fence = ${by.fence} AND process_id IS NULL`.pipe(
          Effect.orDie,
        );
      });

      const releaseConversationsOfLaunch = Effect.fn(
        "HarnessLayoutsRepo.releaseConversationsOfLaunch",
      )(function* (launchId: string) {
        yield* sql`
          UPDATE conversation_processes SET launch_id = NULL, process_id = NULL
          WHERE launch_id = ${launchId}`.pipe(Effect.orDie);
      });

      return {
        ensureIdentity,
        identitiesOf,
        identitiesNamed,
        worktreeLayout,
        requestLayout,
        recordLaunch,
        confirmPerson,
        recordFallback,
        confirm,
        launchLayout,
        anyRecorded,
        capabilityOf,
        recordCapability,
        markConversationShared,
        sharedConversationOf,
        takeConversation,
        bindConversation,
        releaseConversation,
        releaseConversationsOfLaunch,
        conversationHolder,
      };
    }),
  );

/** The in-memory repo's rows, for a test to seed and read. */
export interface HarnessLayoutsMemoryState {
  readonly identities: Map<string, LinuxIdentity>;
  readonly worktrees: Map<string, WorktreeLayoutRecord>;
  readonly launches: Map<string, ExecutorLayoutRecord>;
  readonly capabilities: Map<string, ImageLayoutCapabilityRecord>;
  readonly sharedConversations: Map<string, SharedConversationRecord>;
  readonly conversationHolders: Map<string, ConversationHolder & { readonly takenAt: number }>;
  /** Processes the platform reported exited, as `session_processes.exited_at` would say. */
  readonly exitedProcesses: Set<string>;
}

export const makeHarnessLayoutsMemoryState = (): HarnessLayoutsMemoryState => ({
  identities: new Map(),
  worktrees: new Map(),
  launches: new Map(),
  capabilities: new Map(),
  sharedConversations: new Map(),
  conversationHolders: new Map(),
  exitedProcesses: new Set(),
});

/** In-memory implementation with the same contract, for tests. */
export const harnessLayoutsRepoMemory = (
  state: HarnessLayoutsMemoryState = makeHarnessLayoutsMemoryState(),
): Layer.Layer<HarnessLayoutsRepo> =>
  Layer.succeed(HarnessLayoutsRepo, {
    ensureIdentity: (accountId) =>
      Effect.sync(() => {
        const existing = state.identities.get(accountId);
        if (existing !== undefined) return existing;
        const taken = new Set([...state.identities.values()].map((identity) => identity.name));
        let attempt = 0;
        while (taken.has(linuxLoginNameOf(accountId, attempt))) attempt++;
        const uid =
          Math.max(LINUX_UID_FIRST - 1, ...[...state.identities.values()].map((i) => i.uid)) + 1;
        const identity = new LinuxIdentity({
          accountId,
          name: linuxLoginNameOf(accountId, attempt),
          uid,
        });
        state.identities.set(accountId, identity);
        return identity;
      }),
    identitiesOf: (accountIds) =>
      Effect.sync(() =>
        accountIds
          .flatMap((id) => {
            const identity = state.identities.get(id);
            return identity === undefined ? [] : [identity];
          })
          .toSorted((a, b) => a.uid - b.uid),
      ),
    identitiesNamed: (names) =>
      Effect.sync(() =>
        [...state.identities.values()]
          .filter((identity) => names.includes(identity.name))
          .toSorted((a, b) => a.uid - b.uid),
      ),
    worktreeLayout: (worktreeId) =>
      Effect.sync(() => state.worktrees.get(worktreeId) ?? { layout: null, requested: null }),
    requestLayout: (worktreeId, layout) =>
      Effect.sync(() => {
        const current = state.worktrees.get(worktreeId) ?? { layout: null, requested: null };
        state.worktrees.set(worktreeId, { ...current, requested: layout });
      }),
    recordLaunch: (record) =>
      Effect.sync(() => {
        const existing = state.launches.get(record.launchId);
        if (existing !== undefined && existing.confirmed) return;
        state.launches.set(record.launchId, record);
        if (record.layout === "person" && record.confirmed) {
          const current = state.worktrees.get(record.worktreeId) ?? {
            layout: null,
            requested: null,
          };
          state.worktrees.set(record.worktreeId, { ...current, layout: "person" });
        }
      }),
    confirmPerson: (launchId, worktreeId) =>
      Effect.sync(() => {
        const launch = state.launches.get(launchId);
        if (launch !== undefined && launch.layout === "person") {
          state.launches.set(launchId, { ...launch, confirmed: true });
        }
        const current = state.worktrees.get(worktreeId) ?? { layout: null, requested: null };
        state.worktrees.set(worktreeId, { ...current, layout: "person" });
      }),
    recordFallback: (launchId, reason) =>
      Effect.sync(() => {
        const launch = state.launches.get(launchId);
        if (launch === undefined || launch.confirmed) return;
        state.launches.set(launchId, {
          ...launch,
          layout: "shared",
          source: "fallback",
          reason,
          confirmed: true,
        });
      }),
    confirm: (launchId) =>
      Effect.sync(() => {
        const launch = state.launches.get(launchId);
        if (launch !== undefined && launch.layout === "shared") {
          state.launches.set(launchId, { ...launch, confirmed: true });
        }
      }),
    launchLayout: (launchId) => Effect.sync(() => state.launches.get(launchId) ?? null),
    anyRecorded: () =>
      Effect.sync(
        () =>
          [...state.launches.values()].some((launch) => launch.layout === "person") ||
          [...state.worktrees.values()].some(
            (worktree) => worktree.layout !== null || worktree.requested !== null,
          ),
      ),
    capabilityOf: (imageKey, runtime) =>
      Effect.sync(() => state.capabilities.get(`${imageKey}\u0000${runtime}`) ?? null),
    recordCapability: (record) =>
      Effect.sync(() => {
        state.capabilities.set(`${record.imageKey}\u0000${record.runtime}`, {
          ...record,
          observedAt: new Date(),
        });
      }),
    markConversationShared: (sessionId, owner) =>
      Effect.sync(() => {
        if (!state.sharedConversations.has(sessionId)) {
          state.sharedConversations.set(sessionId, { owner, movedAt: new Date() });
        }
      }),
    sharedConversationOf: (sessionId) =>
      Effect.sync(() => state.sharedConversations.get(sessionId) ?? null),
    takeConversation: (sessionId, launchId) =>
      Effect.sync(() => {
        const held = state.conversationHolders.get(sessionId);
        const free =
          held === undefined ||
          held.launchId === null ||
          (held.processId === null && Date.now() - held.takenAt > CONVERSATION_TAKE_STALE_MS) ||
          (held.processId !== null && state.exitedProcesses.has(held.processId));
        if (!free) {
          return { taken: false, launchId: held.launchId, processId: held.processId } as const;
        }
        const fence = (held?.fence ?? 0) + 1;
        state.conversationHolders.set(sessionId, {
          launchId,
          processId: null,
          fence,
          takenAt: Date.now(),
        });
        return { taken: true, fence } as const;
      }),
    bindConversation: (sessionId, fence, processId) =>
      Effect.sync(() => {
        const held = state.conversationHolders.get(sessionId);
        if (held === undefined || held.fence !== fence || held.launchId === null) return false;
        state.conversationHolders.set(sessionId, { ...held, processId });
        return true;
      }),
    releaseConversation: (sessionId, by) =>
      Effect.sync(() => {
        const held = state.conversationHolders.get(sessionId);
        if (held === undefined) return;
        const matches =
          "processId" in by
            ? held.processId === by.processId
            : held.fence === by.fence && held.processId === null;
        if (matches) {
          state.conversationHolders.set(sessionId, { ...held, launchId: null, processId: null });
        }
      }),
    releaseConversationsOfLaunch: (launchId) =>
      Effect.sync(() => {
        for (const [sessionId, held] of state.conversationHolders) {
          if (held.launchId === launchId) {
            state.conversationHolders.set(sessionId, { ...held, launchId: null, processId: null });
          }
        }
      }),
    conversationHolder: (sessionId) =>
      Effect.sync(() => {
        const held = state.conversationHolders.get(sessionId);
        return held === undefined
          ? null
          : { launchId: held.launchId, processId: held.processId, fence: held.fence };
      }),
  });
