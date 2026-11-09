import { CurrentUser, McpServerRejected, MendApi } from "@mend/api-contracts";
import { McpServersRepo } from "@mend/db";
import {
  MCP_SERVER_LIMITS,
  McpServerName,
  McpServerRemoved,
  McpServersView,
  applySecretEdits,
  mcpSecretsIssue,
  mcpServerNameIssue,
  parseMcpTransport,
  secretKindOf,
} from "@mend/domain/workbench";
import { SecretCipher } from "@mend/store";
import { Effect, Option, Result, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";

const decodeSecrets = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const unseal = (sealed: string) =>
  Effect.gen(function* () {
    const plaintext = yield* (yield* SecretCipher)
      .decrypt(sealed)
      .pipe(Effect.catchTag("SecretCipherError", Effect.die));
    return yield* Option.match(decodeSecrets(plaintext), {
      onNone: () => Effect.die("an MCP server's sealed secrets are not an object of strings"),
      onSome: Effect.succeed,
    });
  });

/**
 * The signed-in person's own MCP servers over `McpServersRepo`. Only ever the caller's own. A
 * save unseals the server's saved secrets, applies the edit, and seals the result here; nothing
 * past this handler holds a value, and no answer or log carries one.
 */
export const McpServersGroupLive = HttpApiBuilder.group(MendApi, "mcpServers", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return new McpServersView({
          servers: yield* (yield* McpServersRepo).list(caller.user.id),
          limits: {
            servers: MCP_SERVER_LIMITS.servers,
            secretsPerServer: MCP_SERVER_LIMITS.secretsPerServer,
            secretValueBytes: MCP_SERVER_LIMITS.secretValueBytes,
            args: MCP_SERVER_LIMITS.args,
            argBytes: MCP_SERVER_LIMITS.argBytes,
          },
        });
      }),
    )
    .handle("save", ({ params, payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const nameIssue = mcpServerNameIssue(params.name);
        if (nameIssue !== null) return yield* new McpServerRejected({ message: nameIssue });
        const name = McpServerName.make(params.name);
        const transport = parseMcpTransport(payload.transport);
        if (Result.isFailure(transport)) {
          return yield* new McpServerRejected({ message: transport.failure });
        }
        const kind = secretKindOf(transport.success);
        const repo = yield* McpServersRepo;
        const saved = yield* repo.sealedSecretsOf(caller.user.id, name);
        const sealedOfSameKind = saved?.kind === kind ? saved.sealed : null;
        const current = sealedOfSameKind === null ? {} : yield* unseal(sealedOfSameKind);
        const secrets = applySecretEdits(current, payload.secrets);
        if (Result.isFailure(secrets)) {
          return yield* new McpServerRejected({ message: secrets.failure });
        }
        const secretsIssue = mcpSecretsIssue(kind, secrets.success);
        if (secretsIssue !== null) return yield* new McpServerRejected({ message: secretsIssue });
        const secretNames = Object.keys(secrets.success).toSorted();
        const sealedSecrets =
          secretNames.length === 0
            ? null
            : yield* (yield* SecretCipher)
                .encrypt(JSON.stringify(secrets.success))
                .pipe(Effect.catchTag("SecretCipherError", Effect.die));
        return yield* repo
          .save(caller.user.id, {
            name,
            transport: transport.success,
            secretNames,
            sealedSecrets,
            ...(payload.enabled === undefined ? {} : { enabled: payload.enabled }),
          })
          .pipe(Effect.mapError((error) => new McpServerRejected({ message: error.message })));
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const removed = yield* (yield* McpServersRepo).remove(caller.user.id, params.name);
        return new McpServerRemoved({ removed });
      }),
    ),
);
