import {
  PreviewPreparationsRepo,
  PreviewsRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  SessionProcessesRepo,
} from "@mend/db";
import { WorktreeId } from "@mend/domain";
import { SlackPreviewReads } from "@mend/jobs";
import { DEFAULT_APP_URL, makePublicNetwork, NetworkConfig } from "@mend/network";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { type PreviewSetup, PreviewSetupConfig } from "./preview-config.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "./preview-gateway-settings.ts";
import { SlackPreviewReadsLive } from "./preview-reads.ts";

const WORKTREE = WorktreeId.make("wt-1");
const ON: PreviewSetup = {
  _tag: "On",
  routing: { mode: "domain-https", domain: "preview.test", port: 443 },
  gateway: { bind: "127.0.0.1", port: 443, ...PREVIEW_GATEWAY_DEFAULTS },
};
const read = (setup: PreviewSetup, previews: Layer.PartialEffectful<PreviewsRepo["Service"]>) =>
  Effect.runPromise(
    Effect.flatMap(SlackPreviewReads, (reads) => Effect.result(reads.forWorktree(WORKTREE))).pipe(
      Effect.provide(
        SlackPreviewReadsLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(PreviewsRepo, previews),
              Layer.mock(PreviewPreparationsRepo, {}),
              Layer.mock(ServiceObservationsRepo, {}),
              Layer.mock(ServicesRepo, {}),
              Layer.mock(SessionProcessesRepo, {}),
              Layer.succeed(PreviewSetupConfig, { setup }),
              Layer.succeed(NetworkConfig, makePublicNetwork(DEFAULT_APP_URL, [])),
            ),
          ),
        ),
      ),
    ),
  );

describe("Slack's read of a worktree's previews", () => {
  it("reads nothing and shows nothing while the gateway is off", async () => {
    const result = await read(
      { _tag: "Off" },
      { readForWorktree: () => Effect.die("read while the gateway is off") },
    );
    expect(result).toMatchObject({ _tag: "Success", success: { _tag: "Hidden" } });
  });

  it("says the read failed, never that there are no previews", async () => {
    const result = await read(ON, { readForWorktree: () => Effect.die("connection refused") });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "PreviewReadUnavailable", worktreeId: WORKTREE },
    });
  });
});
