import { McpServerId } from "@mend/domain";
import {
  MCP_SERVER_LIMITS,
  McpServer,
  type McpSecretKind,
  McpServerName,
  McpTransport,
  secretKindOf,
} from "@mend/domain/workbench";
import { and, asc, eq, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { mcpServers } from "../schema/workbench.ts";

/** A save breaks a limit; the message says which, and repeats nothing submitted. */
export class McpServerInvalidError extends Schema.TaggedError<McpServerInvalidError>()(
  "McpServerInvalidError",
  { message: Schema.String },
) {}

/** A server as a launch needs it: plain fields and its SEALED secrets. */
export interface SealedMcpServer {
  readonly id: McpServerId;
  readonly name: McpServerName;
  readonly transport: McpTransport;
  /** SecretCipher of a JSON object of secret name to value; null when it has none. */
  readonly sealedSecrets: string | null;
}

/** A saved server's secrets as a change needs them: which kind, and the sealed values. */
export interface SealedMcpSecrets {
  readonly kind: McpSecretKind;
  readonly sealed: string | null;
}

/** What a save stores: the transport plain, the secrets sealed by the caller. */
export interface McpServerSave {
  readonly name: McpServerName;
  readonly transport: McpTransport;
  readonly secretNames: ReadonlyArray<string>;
  readonly sealedSecrets: string | null;
  /** Absent: a new server is on, a saved one keeps its state. */
  readonly enabled?: boolean;
}

/**
 * Each person's own MCP servers. Rows hold ciphertext only: sealing and unsealing are the
 * caller's (`@mend/store` SecretCipher). Only `forLaunch` and `sealedSecretsOf` return them.
 */
export class McpServersRepo extends Context.Service<
  McpServersRepo,
  {
    /** Every server the person keeps, by name, without secrets. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<McpServer>>;
    /** The launch read: the servers that are on, by name, secrets sealed. */
    readonly forLaunch: (userId: string) => Effect.Effect<ReadonlyArray<SealedMcpServer>>;
    /** The saved secrets of one server, sealed; null when there is no server by that name. */
    readonly sealedSecretsOf: (
      userId: string,
      name: McpServerName,
    ) => Effect.Effect<SealedMcpSecrets | null>;
    /** Create the server by name, or replace the one saved under it. */
    readonly save: (
      userId: string,
      input: McpServerSave,
    ) => Effect.Effect<McpServer, McpServerInvalidError>;
    /** Whether there was a server by that name to remove. */
    readonly remove: (userId: string, name: string) => Effect.Effect<boolean>;
  }
>()("@mend/db/McpServersRepo") {}

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete" | "execute">;
type Row = typeof mcpServers.$inferSelect;

const decodeTransport = Schema.decodeSync(McpTransport);
const decodeName = Schema.decodeSync(McpServerName);

const toServer = (row: Row): McpServer =>
  new McpServer({
    id: row.id,
    scope: "person",
    name: decodeName(row.name),
    transport: decodeTransport(row.transport),
    secretNames: row.secretNames,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

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
          transport: decodeTransport(row.transport),
          sealedSecrets: row.sealedSecrets,
        }));
    });

    const sealedSecretsOf = Effect.fn("McpServersRepo.sealedSecretsOf")(function* (
      userId: string,
      name: McpServerName,
    ) {
      const [row] = yield* db
        .select({ transport: mcpServers.transport, sealedSecrets: mcpServers.sealedSecrets })
        .from(mcpServers)
        .where(and(mine(userId), eq(mcpServers.name, name)))
        .pipe(Effect.orDie);
      return row === undefined
        ? null
        : { kind: secretKindOf(row.transport), sealed: row.sealedSecrets };
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
              transport: Schema.encodeSync(McpTransport)(input.transport),
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
            const [replaced] = yield* tx
              .update(mcpServers)
              .set({
                ...fields,
                ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
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

    return { list, forLaunch, sealedSecretsOf, save, remove };
  }),
);
