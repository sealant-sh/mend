import {
  AccessKeyNeedsOrganization,
  AccessKeyView,
  CreatedAccessKey,
  CurrentUser,
  MendApi,
  NotFound,
} from "@mend/api-contracts";
import { formatAccessKey, hashAccessKeySecret, mintAccessKeySecret } from "@mend/auth";
import { type AccessKey, AccessKeysRepo, AuditEventsRepo } from "@mend/db";
import { Clock, Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const toAccessKeyView = (key: AccessKey): AccessKeyView =>
  new AccessKeyView({
    id: key.id,
    name: key.name,
    organizationId: key.organizationId,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt === null ? null : key.lastUsedAt.toISOString(),
    expiresAt: key.expiresAt === null ? null : key.expiresAt.toISOString(),
  });

const audited = (key: AccessKey, action: "access_key.created" | "access_key.revoked") =>
  Effect.gen(function* () {
    const caller = yield* CurrentUser;
    yield* (yield* AuditEventsRepo).record({
      organizationId: key.organizationId,
      actorUserId: caller.user.id,
      action,
      subjectType: "access_key",
      subjectId: key.id,
      data: { name: key.name },
    });
  });

/**
 * The signed-in person's access keys (docs/adr/0023-access-keys.md). A key acts in the
 * organization its person was acting in when it was created, and is shown once. The contract
 * refuses an access-key caller on every endpoint here (`PersonCredentialOnly`).
 */
export const AccessKeysGroupLive = HttpApiBuilder.group(MendApi, "accessKeys", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const keys = yield* (yield* AccessKeysRepo).list(caller.user.id);
        return keys.map(toAccessKeyView);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const viewer = yield* (yield* ProjectAccess).viewer();
        if (viewer === null) return yield* new AccessKeyNeedsOrganization();
        const secret = mintAccessKeySecret();
        const now = yield* Clock.currentTimeMillis;
        const key = yield* (yield* AccessKeysRepo).create({
          userId: viewer.userId,
          organizationId: viewer.organizationId,
          name: payload.name,
          secretHash: hashAccessKeySecret(secret),
          expiresAt:
            payload.expiresInDays === null ? null : new Date(now + payload.expiresInDays * DAY_MS),
        });
        yield* audited(key, "access_key.created");
        return new CreatedAccessKey({
          key: toAccessKeyView(key),
          secret: formatAccessKey(key.id, secret),
        });
      }),
    )
    .handle("revoke", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const key = yield* (yield* AccessKeysRepo)
          .revoke(caller.user.id, params.id)
          .pipe(Effect.catchTag("AccessKeyNotFoundError", () => new NotFound({ id: params.id })));
        yield* audited(key, "access_key.revoked");
        return toAccessKeyView(key);
      }),
    ),
);
