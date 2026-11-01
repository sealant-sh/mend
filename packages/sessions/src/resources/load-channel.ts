import { ResourceLoadId, type SessionId } from "@mend/domain";
import { ResourceLoadSource } from "@mend/domain/workbench";
import { Effect, Layer, Schema, Stream } from "effect";

import { SessionChannelRegistry } from "../session-channel.ts";
import { ResourceLoads, ResourceLoadRefused } from "./loads.ts";

/** A session channel never lets an agent choose a different worktree or person. */
export const SessionLoadInput = Schema.Struct({
  name: Schema.String,
  target: Schema.NullOr(Schema.Literals(["shared", "own"])),
  source: ResourceLoadSource,
});
export const ResourceLoadsChannelLive: Layer.Layer<
  never,
  never,
  ResourceLoads | SessionChannelRegistry
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* SessionChannelRegistry;
    const loads = yield* ResourceLoads;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        registry.serveResourceLoads?.(
          (
            sessionId: SessionId,
            method: string,
            id: string | null,
            raw: unknown,
            body: Stream.Stream<Uint8Array, unknown>,
            clock,
          ) =>
            Effect.gen(function* () {
              const { project, viewer, worktreeId } = yield* loads.session(sessionId);
              if (method === "POST") {
                const input = yield* Schema.decodeUnknownEffect(SessionLoadInput)(raw).pipe(
                  Effect.mapError(
                    () =>
                      new ResourceLoadRefused({
                        message: "a load needs a name, target and source",
                      }),
                  ),
                );
                return yield* loads.begin(project, viewer, { ...input, worktreeId }, clock);
              }
              if (id === null || !/^[0-9a-f-]{36}$/.test(id))
                return yield* new ResourceLoadRefused({ message: "load not found" });
              const load = ResourceLoadId.make(id);
              return yield* method === "PUT"
                ? loads.feed(project, viewer, load, body, clock)
                : loads.read(project, viewer, load, clock);
            }),
        ),
      ),
      () => Effect.sync(() => registry.serveResourceLoads?.(undefined)),
    );
  }),
);
