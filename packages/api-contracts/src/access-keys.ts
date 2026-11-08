import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware, PersonCredentialOnly } from "./common.ts";

export const ACCESS_KEY_NAME_MAX = 80;

export const ACCESS_KEY_EXPIRY_DAYS_MAX = 365;

/**
 * One of the signed-in person's access keys (docs/adr/0023-access-keys.md). The secret is never
 * read back: Mend keeps only its hash. Revoked keys drop off the list; expired ones stay on it,
 * marked by `expiresAt` in the past, until revoked.
 */
export class AccessKeyView extends Schema.Class<AccessKeyView>("AccessKeyView")({
  id: Schema.String,
  name: Schema.String,
  /** The organization the key acts in, fixed when it was created. */
  organizationId: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
}) {}

/** What a person asks for: a name, and how many days the key works for (`null`: no expiry). */
export class CreateAccessKeyRequest extends Schema.Class<CreateAccessKeyRequest>(
  "CreateAccessKeyRequest",
)({
  name: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(ACCESS_KEY_NAME_MAX),
  ),
  expiresInDays: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ACCESS_KEY_EXPIRY_DAYS_MAX })),
  ),
}) {}

/** A key as created: the only answer that carries its secret. */
export class CreatedAccessKey extends Schema.Class<CreatedAccessKey>("CreatedAccessKey")({
  key: AccessKeyView,
  /** `mak_<id>_<secret>`, sent whole as `Authorization: Bearer mak_…`. Shown once. */
  secret: Schema.String,
}) {}

/** The person belongs to no organization, so there is none for a key to act in. */
export class AccessKeyNeedsOrganization extends Schema.TaggedError<AccessKeyNeedsOrganization>()(
  "AccessKeyNeedsOrganization",
  {},
  { httpApiStatus: 409 },
) {}

/**
 * The signed-in person's access keys. Every endpoint refuses an access-key caller
 * (`PersonCredentialOnly`): a key never creates, lists or revokes keys.
 */
export const accessKeysGroup = HttpApiGroup.make("accessKeys")
  .add(HttpApiEndpoint.get("list", "/me/access-keys", { success: Schema.Array(AccessKeyView) }))
  .add(
    HttpApiEndpoint.post("create", "/me/access-keys", {
      payload: CreateAccessKeyRequest,
      success: CreatedAccessKey,
      error: [AccessKeyNeedsOrganization],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revoke", "/me/access-keys/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: AccessKeyView,
      error: [NotFound],
    }),
  )
  .middleware(PersonCredentialOnly)
  .middleware(AuthMiddleware);
