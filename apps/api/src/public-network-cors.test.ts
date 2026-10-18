import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { publicNetworkCors } from "./public-network-cors.ts";

const decodeOrigin = Schema.decodeUnknownSync(PublicOrigin);
const network = makePublicNetwork(decodeOrigin("http://localhost:3105"), [
  decodeOrigin("http://mac-mini.local:3105"),
]);
const CorsApi = HttpApi.make("cors").add(
  HttpApiGroup.make("root").add(HttpApiEndpoint.get("get", "/", { success: Schema.String })),
);
const RouteLive = HttpApiBuilder.group(CorsApi, "root", (handlers) =>
  handlers.handle("get", () => Effect.succeed("ok")),
);
const CorsLive = HttpRouter.middleware(publicNetworkCors(network), { global: true });
const ApiLive = HttpApiBuilder.layer(CorsApi).pipe(
  Layer.provide(RouteLive.pipe(Layer.provide(CorsLive))),
  Layer.provide(HttpServer.layerServices),
);

const requestFrom = async (origin: string, init?: RequestInit): Promise<Response> => {
  const { handler, dispose } = HttpRouter.toWebHandler(ApiLive, { disableLogger: true });
  try {
    return await handler(
      new Request("http://api.internal/", {
        ...init,
        headers: { ...init?.headers, origin },
      }),
    );
  } finally {
    await dispose();
  }
};

describe("publicNetworkCors", () => {
  it("allows credentials from an explicitly configured remote origin", async () => {
    const response = await requestFrom("http://mac-mini.local:3105");
    expect(response.headers.get("access-control-allow-origin")).toBe("http://mac-mini.local:3105");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("answers credentialed preflight requests for an explicitly configured origin", async () => {
    const response = await requestFrom("http://mac-mini.local:3105", {
      method: "OPTIONS",
      headers: {
        "access-control-request-headers": "authorization, content-type",
        "access-control-request-method": "POST",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://mac-mini.local:3105");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
  });

  it.each(["http://mac-mini.local:3106", "https://mac-mini.local:3105"])(
    "does not grant CORS to an unlisted origin %s",
    async (origin) => {
      const response = await requestFrom(origin);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    },
  );
});
