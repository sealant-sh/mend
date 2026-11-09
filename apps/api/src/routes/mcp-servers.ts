import { CurrentUser, McpServerRejected, MendApi } from "@mend/api-contracts";
import { McpServersRepo, type SavedMcpServer } from "@mend/db";
import {
  MCP_SERVER_LIMITS,
  McpServerName,
  McpServerRemoved,
  McpServerUrl,
  McpServersView,
  type McpTransport,
  applySecretEdits,
  mcpSecretsIssue,
  mcpServerNameIssue,
  mcpUrlShown,
  parseMcpTransport,
  secretKindOf,
} from "@mend/domain/workbench";
import { SecretCipher } from "@mend/store";
import { Effect, Option, Result, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";

const decodeSecrets = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const seal = (plaintext: string) =>
  Effect.gen(function* () {
    return yield* (yield* SecretCipher)
      .encrypt(plaintext)
      .pipe(Effect.catchTag("SecretCipherError", Effect.die));
  });

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
 * The transport a save stores and its full URL sealed (docs/adr/0024). A URL sent back as the
 * saved server shows it keeps the saved full URL, so an edit or a switch that resends the shown
 * URL never stores `…`; any other URL replaces it. A row saved before URLs were sealed holds its
 * full URL plain, and is sealed here on its next save.
 */
const urlToSave = (transport: McpTransport, saved: SavedMcpServer | null) =>
  Effect.gen(function* () {
    if (transport._tag === "stdio") return { transport, sealedUrl: null };
    const before = saved?.transport;
    const resent =
      before !== undefined && before._tag !== "stdio" && transport.url === mcpUrlShown(before.url);
    if (resent && saved !== null && saved.sealedUrl !== null) {
      return { transport: { _tag: transport._tag, url: before.url }, sealedUrl: saved.sealedUrl };
    }
    const full = resent ? before.url : transport.url;
    const shown = mcpUrlShown(full);
    return {
      transport: { _tag: transport._tag, url: McpServerUrl.make(shown) },
      sealedUrl: shown === full ? null : yield* seal(full),
    };
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
        const saved = yield* repo.savedOf(caller.user.id, name);
        const sealedOfSameKind =
          saved !== null && secretKindOf(saved.transport) === kind ? saved.sealedSecrets : null;
        const current = sealedOfSameKind === null ? {} : yield* unseal(sealedOfSameKind);
        const secrets = applySecretEdits(current, payload.secrets);
        if (Result.isFailure(secrets)) {
          return yield* new McpServerRejected({ message: secrets.failure });
        }
        const secretsIssue = mcpSecretsIssue(kind, secrets.success);
        if (secretsIssue !== null) return yield* new McpServerRejected({ message: secretsIssue });
        const secretNames = Object.keys(secrets.success).toSorted();
        const sealedSecrets =
          secretNames.length === 0 ? null : yield* seal(JSON.stringify(secrets.success));
        return yield* repo
          .save(caller.user.id, {
            name,
            ...(yield* urlToSave(transport.success, saved)),
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
