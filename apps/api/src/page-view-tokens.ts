import { createHmac, timingSafeEqual } from "node:crypto";

import { PAGE_FRAME_TTL_MS, PageAppearance } from "@mend/api-contracts";
import { authSecret } from "@mend/auth";
import { PageId } from "@mend/domain";
import { Clock, type Config, Effect, Layer, Redacted, Schema } from "effect";
import * as Context from "effect/Context";

export interface PageViewGrant {
  readonly pageId: PageId;
  readonly accountId: string;
  readonly appearance: PageAppearance;
}

export interface IssuedPageView {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: Date;
}

export class PageViewTokens extends Context.Service<
  PageViewTokens,
  {
    readonly issue: (grant: PageViewGrant) => Effect.Effect<IssuedPageView>;
    readonly read: (token: Redacted.Redacted<string>) => Effect.Effect<PageViewGrant | null>;
  }
>()("@mend/api/PageViewTokens") {}

export const pageViewKeyOf = (betterAuthSecret: string): Buffer =>
  createHmac("sha256", betterAuthSecret).update("mend page view key").digest();

const Claim = Schema.Struct({
  version: Schema.Literal(1),
  page: PageId,
  account: Schema.String,
  appearance: PageAppearance,
  expiresAt: Schema.Int,
});
const ClaimJson = Schema.fromJsonString(Claim);
const encodeClaim = Schema.encodeSync(ClaimJson);
const decodeClaim = Schema.decodeUnknownOption(ClaimJson);

export const pageViewTokensOf = (
  key: Buffer,
  ttlMs: number = PAGE_FRAME_TTL_MS,
): PageViewTokens["Service"] => {
  const signatureOf = (payload: string) =>
    createHmac("sha256", key).update(payload).digest("base64url");

  const issue = (grant: PageViewGrant) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const expiresAt = now + ttlMs;
      const payload = Buffer.from(
        encodeClaim({
          version: 1,
          page: grant.pageId,
          account: grant.accountId,
          appearance: grant.appearance,
          expiresAt,
        }),
      ).toString("base64url");
      return {
        token: Redacted.make(`${payload}.${signatureOf(payload)}`),
        expiresAt: new Date(expiresAt),
      };
    });

  const read = (token: Redacted.Redacted<string>) =>
    Effect.map(Clock.currentTimeMillis, (now): PageViewGrant | null => {
      const [payload, signature, ...rest] = Redacted.value(token).split(".");
      if (payload === undefined || signature === undefined || rest.length > 0) return null;
      const expected = Buffer.from(signatureOf(payload));
      const given = Buffer.from(signature);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      const claim = decodeClaim(Buffer.from(payload, "base64url").toString("utf8"));
      if (claim._tag === "None" || claim.value.expiresAt <= now) return null;
      return {
        pageId: claim.value.page,
        accountId: claim.value.account,
        appearance: claim.value.appearance,
      };
    });

  return { issue, read };
};

export const PageViewTokensLive: Layer.Layer<PageViewTokens, Config.ConfigError> = Layer.effect(
  PageViewTokens,
  Effect.gen(function* () {
    const secret = yield* authSecret;
    return pageViewTokensOf(pageViewKeyOf(Redacted.value(secret)));
  }),
);
