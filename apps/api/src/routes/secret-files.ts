import { CurrentUser, MendApi, SecretFileRejected } from "@mend/api-contracts";
import { SecretFilesRepo } from "@mend/db";
import {
  SecretFileRemoved,
  SecretFileSaved,
  SecretFilesView,
  secretFileBytes,
  validateSecretFileContent,
  validateSecretFilePath,
} from "@mend/domain/workbench";
import { SecretCipher } from "@mend/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

/**
 * The signed-in account's secret files (docs/adr/0010-secret-files.md) over `SecretFilesRepo`.
 * Only ever the caller's own: there is no route to anyone else's. The content is checked, sealed
 * with the machine's secrets key here, and stored sealed; nothing past this handler holds it, and
 * no handler returns it. A session reads the sealed set at launch, so nothing running changes on
 * a save.
 */
export const SecretFilesGroupLive = HttpApiBuilder.group(MendApi, "secretFiles", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return new SecretFilesView({ files: yield* (yield* SecretFilesRepo).list(caller.user.id) });
      }),
    )
    .handle("save", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const pathIssue = validateSecretFilePath(payload.path);
        if (pathIssue !== null) return yield* new SecretFileRejected({ message: pathIssue });
        const contentIssue = validateSecretFileContent(payload);
        if (contentIssue !== null) return yield* new SecretFileRejected({ message: contentIssue });
        const bytes = secretFileBytes(payload);
        if (bytes === null)
          return yield* new SecretFileRejected({ message: "the content is not valid base64" });
        // Sealed as base64 so a binary file (a keytab, a PKCS#12 bundle) round-trips exactly.
        const sealedContents = yield* (yield* SecretCipher)
          .encrypt(Buffer.from(bytes).toString("base64"))
          .pipe(Effect.catchTag("SecretCipherError", Effect.die));
        const saved = yield* (yield* SecretFilesRepo)
          .save(caller.user.id, { path: payload.path, sealedContents, bytes: bytes.byteLength })
          .pipe(Effect.mapError((error) => new SecretFileRejected({ message: error.message })));
        return new SecretFileSaved(saved);
      }),
    )
    .handle("remove", ({ query }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const removed = yield* (yield* SecretFilesRepo).remove(caller.user.id, query.path);
        return new SecretFileRemoved({ removed });
      }),
    ),
);
