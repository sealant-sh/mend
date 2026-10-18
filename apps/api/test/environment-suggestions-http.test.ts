import { HostEnvironmentSuggestionsView } from "@mend/api-contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { describe, expect, it } from "vitest";

import type { HostEnvironmentSuggestions } from "../src/services/host-environment.ts";

const SuggestionsApi = HttpApi.make("suggestionsApi").add(
  HttpApiGroup.make("suggestions").add(
    HttpApiEndpoint.get("get", "/", {
      success: HostEnvironmentSuggestionsView,
    }),
  ),
);

describe("HostEnvironmentSuggestionsView HTTP encoding", () => {
  it("encodes the scanner's plain-object result as a successful response", async () => {
    const result: HostEnvironmentSuggestions = {
      tools: [{ executable: "docker", kind: "service", id: "docker" }],
      configs: [{ label: "GitHub CLI", path: "~/.config/gh/config.yml" }],
    };
    const SuggestionsLive = HttpApiBuilder.group(SuggestionsApi, "suggestions", (handlers) =>
      handlers.handle("get", () => Effect.succeed(result)),
    );
    const ApiLive = HttpApiBuilder.layer(SuggestionsApi).pipe(
      Layer.provide(SuggestionsLive),
      Layer.provide(HttpServer.layerServices),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(ApiLive, { disableLogger: true });

    try {
      const response = await handler(new Request("http://localhost/"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(result);
    } finally {
      await dispose();
    }
  });
});
