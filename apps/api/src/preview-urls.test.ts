import { PreviewsRepo } from "@mend/db";
import { PreviewId, PreviewLabel, ProjectId, WorktreeId } from "@mend/domain";
import type { PreviewView } from "@mend/domain/workbench";
import { PreviewUrls } from "@mend/sessions";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { type PreviewSetup, PreviewSetupConfig } from "./preview-config.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "./preview-gateway-settings.ts";
import type { PreviewRouting } from "./preview-routing.ts";
import { PreviewUrlsLive } from "./preview-urls.ts";

const WORKTREE = WorktreeId.make("worktree-1");
const LABEL = PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa");
const WEB: PreviewView = {
  preview: {
    id: PreviewId.make("preview-web"),
    projectId: ProjectId.make("project-1"),
    worktreeId: WORKTREE,
    serviceName: "web",
    label: LABEL,
    state: "kept",
  },
  binding: { _tag: "Unbound", reason: "no-live-attempt" },
};

const on = (routing: PreviewRouting): PreviewSetup => ({
  _tag: "On",
  routing,
  gateway: { bind: "127.0.0.1", port: 3200, ...PREVIEW_GATEWAY_DEFAULTS },
});

const urlOf = (
  setup: PreviewSetup,
  serviceName: string,
  ports: ReadonlyMap<PreviewId, number> = new Map(),
) =>
  Effect.runPromise(
    Effect.flatMap(PreviewUrls, (urls) => urls.of(WORKTREE, serviceName)).pipe(
      Effect.provide(
        PreviewUrlsLive.pipe(
          Layer.provide(Layer.succeed(PreviewSetupConfig, { setup })),
          Layer.provide(
            Layer.mock(PreviewsRepo, {
              ensureForWorktree: () => Effect.succeed([WEB]),
              tailnetPorts: () => Effect.succeed(ports),
            }),
          ),
        ),
      ),
    ),
  );

describe("MEND_PREVIEW_URL", () => {
  it("is the preview's origin under the routing", async () => {
    expect(await urlOf(on({ mode: "loopback-http", port: 3200 }), "web")).toBe(
      `http://${LABEL}.localhost:3200`,
    );
    expect(
      await urlOf(on({ mode: "domain-https", domain: "preview.test", port: 443 }), "web"),
    ).toBe(`https://${LABEL}.preview.test`);
  });

  it("is none while previews are off, for a Service with no preview, and before a tailnet port", async () => {
    expect(await urlOf({ _tag: "Off" }, "web")).toBeNull();
    expect(await urlOf(on({ mode: "loopback-http", port: 3200 }), "db")).toBeNull();
    const tailnet = on({ mode: "tailnet-https", hostname: "mend.tail.ts.net", ports: [20001] });
    expect(await urlOf(tailnet, "web")).toBeNull();
    expect(await urlOf(tailnet, "web", new Map([[WEB.preview.id, 20001]]))).toBe(
      "https://mend.tail.ts.net:20001",
    );
  });
});
