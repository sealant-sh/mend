import { Config, Effect, Layer, Option, Redacted } from "effect";
import * as Context from "effect/Context";

/**
 * Where the operator's Sealant control plane lives, and the SERVICE KEY Mend
 * presents to it. Mend is a service principal: it authenticates once as the
 * product and acts on behalf of each signed-in user (docs/SEALANT-IDENTITY.md).
 * `SEALANT_API_KEY` is honoured as the older name for the same secret.
 */
export class SealantEnv extends Context.Service<
  SealantEnv,
  {
    readonly baseUrl: string;
    readonly serviceKey: Option.Option<Redacted.Redacted>;
  }
>()("@mend/sealant/SealantEnv") {
  static readonly layer = Layer.effect(
    SealantEnv,
    Effect.gen(function* () {
      const baseUrl = yield* Config.String("SEALANT_BASE_URL").pipe(
        Config.orElse(() => Config.succeed("http://localhost:8080")),
      );
      const serviceKey = yield* Config.option(
        Config.Redacted("SEALANT_SERVICE_KEY").pipe(
          Config.orElse(() => Config.Redacted("SEALANT_API_KEY")),
        ),
      );
      return { baseUrl, serviceKey };
    }),
  );
}
