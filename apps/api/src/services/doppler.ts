import { DopplerUnavailable } from "@mend/api-contracts";
import { DopplerConfigs, DopplerProjects } from "@mend/domain/workbench";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as Context from "effect/Context";

/** Only the picker calls Doppler. Neither connection save nor session launch uses it. */
export class DopplerApi extends Context.Service<
  DopplerApi,
  {
    readonly projects: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<typeof DopplerProjects.Type, DopplerUnavailable>;
    readonly configs: (
      token: Redacted.Redacted<string>,
      project: string,
    ) => Effect.Effect<typeof DopplerConfigs.Type, DopplerUnavailable>;
  }
>()("@mend/api/DopplerApi") {}

const get = (token: Redacted.Redacted<string>, path: string) =>
  Effect.tryPromise({
    try: async (): Promise<unknown> => {
      const response = await fetch(`https://api.doppler.com/v3/${path}`, {
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Doppler request failed");
      return response.json();
    },
    // Never retain a request, response body, headers or the original fetch exception.
    catch: () =>
      new DopplerUnavailable({
        message:
          "Doppler could not list these choices. Check your connection and token permissions.",
      }),
  });

export const DopplerApiLive: Layer.Layer<DopplerApi> = Layer.succeed(DopplerApi, {
  projects: (token) =>
    get(token, "projects?per_page=100").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DopplerProjects)),
      Effect.mapError(
        () => new DopplerUnavailable({ message: "Doppler could not list projects." }),
      ),
    ),
  configs: (token, project) =>
    get(token, `configs?project=${encodeURIComponent(project)}&per_page=100`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DopplerConfigs)),
      Effect.mapError(() => new DopplerUnavailable({ message: "Doppler could not list configs." })),
    ),
});
