import * as http from "node:http";

import { InferenceCallsRepo } from "@mend/db";
import { InferenceProvider, sealantProviderLayer } from "@mend/inference";
import {
  asSealantUser,
  SealantClientLive,
  SealantClientsLive,
  SealantEnv,
  SealantIdentityStore,
} from "@mend/sealant";
import { type Config, ConfigProvider, Effect, Layer, Option } from "effect";
import { expect, it } from "vitest";

import { generateWorktreeCommitMessage } from "../src/worktree-commit.ts";

const preview = { summary: "M\tREADME.md", patch: "+Hello", recentMessages: "docs: setup" };
const selectedModels = [
  {
    model: "gpt-6-luna",
    reason: "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.",
  },
  {
    model: "gpt-6-astra",
    reason:
      "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
  },
];

// Replay Core's public HTTP contract through the installed SDK's Effect operation, the
// dispatching person client and the shipped inference provider. No pretranslated error fake.
const withCore = async (
  reply: (attempt: number) => { status: number; body: unknown },
  run: (
    layer: Layer.Layer<InferenceProvider, Config.ConfigError>,
    requests: unknown[],
  ) => Promise<void>,
) => {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/inference/respond") {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = reply(requests.length);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No loopback port");
    const layer = sealantProviderLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          SealantClientLive.pipe(
            Layer.provide(SealantClientsLive),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(SealantEnv, {
                  baseUrl: `http://127.0.0.1:${address.port}`,
                  serviceKey: Option.none(),
                }),
                Layer.succeed(SealantIdentityStore, {
                  user: (userId) =>
                    Effect.succeed({ id: userId, email: `${userId}@mend.test`, name: userId }),
                  sealantUserId: (userId) => Effect.succeed(`su-${userId}`),
                  record: () => Effect.void,
                }),
              ),
            ),
          ),
          Layer.succeed(InferenceCallsRepo, { record: () => Effect.void }),
        ),
      ),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );
    await run(layer, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
};

const engineRefusal = (reason: string) => ({
  status: 500,
  body: {
    _tag: "InferenceInternalServerError",
    message: `Codex inference failed: ${JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: reason } })}`,
  },
});

it("retains Core's typed engine failure without the Promise facade's numeric HTTP status", async () => {
  await withCore(
    () => engineRefusal("Selected model rejected."),
    async (layer, requests) => {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* InferenceProvider).respond({
            context: "git-commit",
            provider: "codex",
            model: "gpt-6-luna",
            prompt: "Write a commit message.",
          });
        }).pipe(asSealantUser("alice"), Effect.flip, Effect.provide(layer)),
      );
      expect(error.cause).toMatchObject({ code: "InferenceInternalServerError", status: null });
      expect(requests).toMatchObject([{ ownerUserId: "su-alice" }]);
    },
  );
});

for (const { model, reason } of selectedModels) {
  it(`generates after Core's real selected-model refusal for ${model}`, async () => {
    await withCore(
      (attempt) =>
        attempt === 1
          ? engineRefusal(reason)
          : {
              status: 200,
              body: {
                sessionId: "inference-2",
                turn: { type: "text", text: '{"subject":"Add greeting","body":""}' },
              },
            },
      async (layer, requests) => {
        const message = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* generateWorktreeCommitMessage(
              yield* InferenceProvider,
              "alice",
              { provider: "codex", model },
              preview,
            );
          }).pipe(Effect.provide(layer)),
        );
        expect(message).toBe("Add greeting");
        expect(requests).toMatchObject([
          { ownerUserId: "su-alice", model, credentials: { codex: "default" } },
          { ownerUserId: "su-alice", model: "gpt-5.6-luna", credentials: { codex: "default" } },
        ]);
      },
    );
  });
}

it("keeps both native reasons if the ordinary model fails through the SDK too", async () => {
  await withCore(
    (attempt) =>
      engineRefusal(attempt === 1 ? "Selected model rejected." : "Ordinary model failed."),
    async (layer, requests) => {
      const refusal = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* generateWorktreeCommitMessage(
            yield* InferenceProvider,
            "alice",
            { provider: "codex", model: "gpt-6-luna" },
            preview,
          );
        }).pipe(Effect.flip, Effect.provide(layer)),
      );
      expect(requests).toHaveLength(2);
      expect(refusal.message).toContain("Selected model rejected.");
      expect(refusal.message).toContain("Ordinary model failed.");
      expect(refusal.message).toContain("Nothing was committed.");
    },
  );
});

it("does not retry a real connected-account refusal with another model", async () => {
  await withCore(
    () => ({
      status: 409,
      body: { _tag: "InferenceConflictError", message: "Reconnect your Codex login." },
    }),
    async (layer, requests) => {
      const refusal = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* generateWorktreeCommitMessage(
            yield* InferenceProvider,
            "alice",
            { provider: "codex", model: "gpt-6-luna" },
            preview,
          );
        }).pipe(Effect.flip, Effect.provide(layer)),
      );
      expect(requests).toHaveLength(1);
      expect(refusal.message).toContain("Reconnect your Codex login.");
      expect(refusal.message).toContain("Nothing was committed.");
    },
  );
});
