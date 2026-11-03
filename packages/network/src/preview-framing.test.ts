import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  loadPreviewPlacement,
  type PreviewPlacement,
  previewFrameAncestors,
  previewFrameSite,
  previewFrameSource,
} from "./preview-framing.ts";
import { makePublicNetwork, PublicOrigin } from "./public-network.ts";

const domain = (name: string, port = 443): PreviewPlacement => ({
  mode: "domain-https",
  domain: name,
  port,
});

const placementOf = (env: Record<string, string>) =>
  Effect.runSync(
    loadPreviewPlacement.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );

describe("which previews Mend's app shows in a frame", () => {
  it.each([
    [
      "the box: a preview domain beside Mend's host",
      domain("previews.mend.run"),
      "https://alpha.mend.run",
      "mend.run",
      "https://*.previews.mend.run",
    ],
    [
      "a preview domain on another public port",
      domain("previews.mend.run", 8443),
      "https://alpha.mend.run",
      "mend.run",
      "https://*.previews.mend.run:8443",
    ],
    [
      "previews on a tailnet name of Mend's own tailnet",
      { mode: "tailnet-https", hostname: "mend-preview.tail1.ts.net" },
      "https://mend-box.tail1.ts.net",
      "tail1.ts.net",
      "https://mend-preview.tail1.ts.net:*",
    ],
    [
      "a preview domain on another site",
      domain("previews.example.net"),
      "https://alpha.mend.run",
      null,
      null,
    ],
    [
      "another tailnet",
      { mode: "tailnet-https", hostname: "mend-preview.tail2.ts.net" },
      "https://mend-box.tail1.ts.net",
      null,
      null,
    ],
    ["Mend over http", domain("previews.mend.run"), "http://alpha.mend.run", null, null],
    [
      "loopback previews at *.localhost",
      { mode: "loopback-http" },
      "http://localhost:3105",
      null,
      null,
    ],
    ["previews off", null, "https://alpha.mend.run", null, null],
  ] as const)("%s", (_, placement, appUrl, site, source) => {
    expect(previewFrameSite(placement, appUrl)).toBe(site);
    expect(previewFrameSource(placement, appUrl)).toBe(source);
  });

  it("lets only the preview itself and Mend's own origins frame a preview", () => {
    const network = makePublicNetwork(PublicOrigin.make("https://alpha.mend.run"), [
      PublicOrigin.make("https://mend-box.tail1.ts.net:8443"),
    ]);
    expect(previewFrameAncestors(network)).toBe(
      "frame-ancestors 'self' https://alpha.mend.run https://mend-box.tail1.ts.net:8443",
    );
  });

  it("reads the placement from the variables the API reads, a domain before a tailnet", () => {
    expect(placementOf({})).toBeNull();
    expect(placementOf({ MEND_PREVIEW_DOMAIN: "previews.mend.run" })).toEqual(
      domain("previews.mend.run"),
    );
    expect(
      placementOf({
        MEND_PREVIEW_DOMAIN: "previews.mend.run",
        MEND_PREVIEW_PUBLIC_PORT: "8443",
        MEND_PREVIEW_TAILNET_HOSTNAME: "mend-preview.tail1.ts.net",
      }),
    ).toEqual(domain("previews.mend.run", 8443));
    expect(placementOf({ MEND_PREVIEW_TAILNET_HOSTNAME: "mend-preview.tail1.ts.net" })).toEqual({
      mode: "tailnet-https",
      hostname: "mend-preview.tail1.ts.net",
    });
  });
});
