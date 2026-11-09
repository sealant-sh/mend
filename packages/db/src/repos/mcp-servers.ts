import { McpServerId } from "@mend/domain";
import {
  MCP_SERVER_LIMITS,
  McpServer,
  McpServerName,
  McpServerUrl,
  McpStoredTransport,
  McpTransport,
  mcpUrlShown,
} from "@mend/domain/workbench";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { mcpServers } from "../schema/workbench.ts";

/** A save breaks a limit; the message says which, and repeats nothing submitted. */
export class McpServerInvalidError extends Schema.TaggedError<McpServerInvalidError>()(
  "McpServerInvalidError",
  { message: Schema.String },
) {}

/**
 * A saved server as its row keeps it: the transport with an HTTP or SSE URL as shown
 * (`mcpUrlShown`), the full URL sealed beside it when the two differ, and the secrets sealed.
 */
export interface SavedMcpServer {
  readonly transport: McpTransport;
  /**
   * SecretCipher of the full URL; null when the URL is as shown. A row saved before URLs were
   * sealed has none and holds its full URL in `transport`.
   */
  readonly sealedUrl: string | null;
  /** SecretCipher of a JSON object of secret name to value; null when it has none. */
  readonly sealedSecrets: string | null;
}

/** A server as a launch needs it: its row, URL and secrets still SEALED. */
export interface SealedMcpServer extends SavedMcpServer {
  readonly id: McpServerId;
  readonly name: McpServerName;
  readonly signIn: SealedMcpSignIn | null;
  /** The last Forget, URL or transport change; null when there was none. */
  readonly signInResetAt: Date | null;
}

/** A kept sign-in as a launch puts it back: Claude's key and its entry, sealed. */
export interface SealedMcpSignIn {
  readonly key: string;
  /** SecretCipher of Claude's `mcpOAuth` entry, as JSON. */
  readonly sealed: string;
  readonly expiresAt: Date;
}

/** A sign-in the person's harness wrote, as Mend's helper saw it in the credentials file. */
export interface McpSignInObserved {
  readonly serverName: string;
  /**
   * The server's URL as its row keeps it: shown, when its full URL is sealed. The caller matches
   * the harness's full URL against the unsealed one first (`keepSignIn` cannot unseal).
   */
  readonly serverUrl: string;
  readonly key: string;
  readonly sealed: string;
  readonly expiresAt: Date;
  /** When the process that saw it started: a post from before the last reset loses. */
  readonly processStartedAt: Date;
}

/**
 * `kept`: stored. `older`: Mend keeps one that expires as late or later. `no-server`: no HTTP or
 * SSE server of the person's has that name and URL. `reset`: the process started before the
 * server's last Forget, URL or transport change.
 */
export type McpSignInKept = "kept" | "older" | "no-server" | "reset";

/** What a save stores: the transport as shown, the full URL and the secrets sealed by the caller. */
export interface McpServerSave extends SavedMcpServer {
  readonly name: McpServerName;
  readonly secretNames: ReadonlyArray<string>;
  /** Absent: a new server is on, a saved one keeps its state. */
  readonly enabled?: boolean;
}

/**
 * Each person's own MCP servers. Rows hold ciphertext only: sealing and unsealing are the
 * caller's (`@mend/store` SecretCipher). Only `forLaunch` and `savedOf` return it.
 */
export class McpServersRepo extends Context.Service<
  McpServersRepo,
  {
    /** Every server the person keeps, by name, without secrets. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<McpServer>>;
    /** The launch read: the servers that are on, by name, URL and secrets sealed. */
    readonly forLaunch: (userId: string) => Effect.Effect<ReadonlyArray<SealedMcpServer>>;
    /** One server as saved, for a change to build on; null when there is none by that name. */
    readonly savedOf: (userId: string, name: McpServerName) => Effect.Effect<SavedMcpServer | null>;
    /** Create the server by name, or replace the one saved under it. */
    readonly save: (
      userId: string,
      input: McpServerSave,
    ) => Effect.Effect<McpServer, McpServerInvalidError>;
    /** Whether there was a server by that name to remove. */
    readonly remove: (userId: string, name: string) => Effect.Effect<boolean>;
    /** Store a sign-in when it is newer than the one kept, in one statement (newest wins). */
    readonly keepSignIn: (userId: string, input: McpSignInObserved) => Effect.Effect<McpSignInKept>;
    /** Drop the server's sign-in and note when; null when there is no server by that name. */
    readonly forgetSignIn: (userId: string, name: string) => Effect.Effect<McpServer | null>;
  }
>()("@mend/db/McpServersRepo") {}

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete" | "execute">;
type Row = typeof mcpServers.$inferSelect;

const decodeStored = Schema.decodeSync(McpStoredTransport);
const decodeName = Schema.decodeSync(McpServerName);

const savedOfRow = (row: Pick<Row, "transport" | "sealedSecrets">): SavedMcpServer => {
  const stored = decodeStored(row.transport);
  return stored._tag === "stdio"
    ? { transport: stored, sealedUrl: null, sealedSecrets: row.sealedSecrets }
    : {
        transport: { _tag: stored._tag, url: stored.url },
        sealedUrl: stored.sealedUrl ?? null,
        sealedSecrets: row.sealedSecrets,
      };
};

const storedOf = (saved: SavedMcpServer): typeof McpStoredTransport.Encoded =>
  saved.transport._tag === "stdio" || saved.sealedUrl === null
    ? saved.transport
    : { ...saved.transport, sealedUrl: saved.sealedUrl };

/** Shown on every read, so a row saved with its full URL in the clear never shows a key either. */
const shownTransport = (transport: McpTransport): McpTransport =>
  transport._tag === "stdio"
    ? transport
    : { _tag: transport._tag, url: McpServerUrl.make(mcpUrlShown(transport.url)) };

const toServer = (row: Row): McpServer =>
  new McpServer({
    id: row.id,
    scope: "person",
    name: decodeName(row.name),
    transport: shownTransport(savedOfRow(row).transport),
    secretNames: row.secretNames,
    enabled: row.enabled,
    signIn:
      row.signInObservedAt === null || row.signInExpiresAt === null
        ? null
        : { observedAt: row.signInObservedAt, expiresAt: row.signInExpiresAt },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const signInOf = (row: Row): SealedMcpSignIn | null =>
  row.sealedSignIn === null || row.signInKey === null || row.signInExpiresAt === null
    ? null
    : { key: row.signInKey, sealed: row.sealedSignIn, expiresAt: row.signInExpiresAt };

/**
 * What a sign-in is for: Claude's key hashes the transport and URL, so a change forgets it. A
 * sealed full URL counts by its ciphertext, which a save keeps unless a new URL replaces it.
 */
const signInTargetOf = (saved: SavedMcpServer): string =>
  saved.transport._tag === "stdio"
    ? "stdio"
    : `${saved.transport._tag} ${saved.transport.url} ${saved.sealedUrl ?? ""}`;

const SIGN_IN_FORGOTTEN = {
  sealedSignIn: null,
  signInKey: null,
  signInExpiresAt: null,
  signInObservedAt: null,
  signInResetAt: sql`now()`,
} as const;

const serializePersonWrites = (tx: Tx, userId: string) =>
  tx
    .execute(sql`select pg_advisory_xact_lock(hashtext(${`mend:mcp-servers:${userId}`}))`)
    .pipe(Effect.orDie);

const mine = (userId: string) => and(eq(mcpServers.scope, "person"), eq(mcpServers.userId, userId));

const rowsOf = (tx: Tx, userId: string) =>
  tx.select().from(mcpServers).where(mine(userId)).orderBy(asc(mcpServers.name)).pipe(Effect.orDie);

const saveIssue = (input: McpServerSave): string | null => {
  if (input.secretNames.length > MCP_SERVER_LIMITS.secretsPerServer) {
    return `a server keeps at most ${MCP_SERVER_LIMITS.secretsPerServer} variables or headers`;
  }
  if ((input.sealedSecrets?.length ?? 0) > MCP_SERVER_LIMITS.sealedBytes) {
    return `a server's variables or headers total over ${MCP_SERVER_LIMITS.sealedBytes / 1024} KB`;
  }
  return null;
};

export const McpServersRepoLive: Layer.Layer<McpServersRepo, never, MendDB> = Layer.effect(
  McpServersRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const list = Effect.fn("McpServersRepo.list")(function* (userId: string) {
      return (yield* rowsOf(db, userId)).map(toServer);
    });

    const forLaunch = Effect.fn("McpServersRepo.forLaunch")(function* (userId: string) {
      return (yield* rowsOf(db, userId))
        .filter((row) => row.enabled)
        .map((row) => ({
          id: row.id,
          name: decodeName(row.name),
          ...savedOfRow(row),
          signIn: signInOf(row),
          signInResetAt: row.signInResetAt,
        }));
    });

    const savedOf = Effect.fn("McpServersRepo.savedOf")(function* (
      userId: string,
      name: McpServerName,
    ) {
      const [row] = yield* db
        .select({ transport: mcpServers.transport, sealedSecrets: mcpServers.sealedSecrets })
        .from(mcpServers)
        .where(and(mine(userId), eq(mcpServers.name, name)))
        .pipe(Effect.orDie);
      return row === undefined ? null : savedOfRow(row);
    });

    const save = Effect.fn("McpServersRepo.save")(function* (userId: string, input: McpServerSave) {
      const issue = saveIssue(input);
      if (issue !== null) return yield* new McpServerInvalidError({ message: issue });
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* serializePersonWrites(tx, userId);
            const existing = yield* rowsOf(tx, userId);
            const current = existing.find((row) => row.name === input.name);
            const fields = {
              transport: storedOf(input),
              secretNames: [...input.secretNames],
              sealedSecrets: input.sealedSecrets,
            };
            if (current === undefined) {
              if (existing.length >= MCP_SERVER_LIMITS.servers) {
                return yield* new McpServerInvalidError({
                  message: `you already keep ${MCP_SERVER_LIMITS.servers} MCP servers, the most Mend holds per person`,
                });
              }
              const [created] = yield* tx
                .insert(mcpServers)
                .values({
                  id: McpServerId.make(crypto.randomUUID()),
                  scope: "person",
                  userId,
                  name: input.name,
                  ...fields,
                  enabled: input.enabled ?? true,
                })
                .returning()
                .pipe(Effect.orDie);
              if (created === undefined)
                return yield* Effect.die("MCP server insert returned no row");
              return toServer(created);
            }
            const retargeted =
              signInTargetOf(savedOfRow(current)) !== signInTargetOf(input);
            const [replaced] = yield* tx
              .update(mcpServers)
              .set({
                ...fields,
                ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
                ...(retargeted ? SIGN_IN_FORGOTTEN : {}),
                updatedAt: yield* DateTime.nowAsDate,
              })
              .where(eq(mcpServers.id, current.id))
              .returning()
              .pipe(Effect.orDie);
            if (replaced === undefined) return yield* Effect.die("MCP server update lost the row");
            return toServer(replaced);
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const remove = Effect.fn("McpServersRepo.remove")(function* (userId: string, name: string) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* serializePersonWrites(tx, userId);
            const deleted = yield* tx
              .delete(mcpServers)
              .where(and(mine(userId), eq(mcpServers.name, name)))
              .returning({ id: mcpServers.id })
              .pipe(Effect.orDie);
            return deleted.length > 0;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const keepSignIn = Effect.fn("McpServersRepo.keepSignIn")(function* (
      userId: string,
      input: McpSignInObserved,
    ) {
      const server = and(
        mine(userId),
        sql`lower(${mcpServers.name}) = lower(${input.serverName})`,
        sql`${mcpServers.transport}->>'_tag' IN ('http', 'sse')`,
        sql`${mcpServers.transport}->>'url' = ${input.serverUrl}`,
      );
      const kept = yield* db
        .update(mcpServers)
        .set({
          sealedSignIn: input.sealed,
          signInKey: input.key,
          signInExpiresAt: input.expiresAt,
          signInObservedAt: sql`now()`,
        })
        .where(
          and(
            server,
            or(
              isNull(mcpServers.signInResetAt),
              lte(mcpServers.signInResetAt, input.processStartedAt),
            ),
            or(isNull(mcpServers.signInExpiresAt), lt(mcpServers.signInExpiresAt, input.expiresAt)),
          ),
        )
        .returning({ id: mcpServers.id })
        .pipe(Effect.orDie);
      if (kept.length > 0) return "kept" satisfies McpSignInKept;
      const [row] = yield* db
        .select({ resetAt: mcpServers.signInResetAt })
        .from(mcpServers)
        .where(server)
        .pipe(Effect.orDie);
      if (row === undefined) return "no-server" satisfies McpSignInKept;
      return row.resetAt !== null && row.resetAt > input.processStartedAt
        ? ("reset" satisfies McpSignInKept)
        : ("older" satisfies McpSignInKept);
    });

    const forgetSignIn = Effect.fn("McpServersRepo.forgetSignIn")(function* (
      userId: string,
      name: string,
    ) {
      const [forgotten] = yield* db
        .update(mcpServers)
        .set(SIGN_IN_FORGOTTEN)
        .where(and(mine(userId), eq(mcpServers.name, name)))
        .returning()
        .pipe(Effect.orDie);
      return forgotten === undefined ? null : toServer(forgotten);
    });

    return { list, forLaunch, savedOf, save, remove, keepSignIn, forgetSignIn };
  }),
);
