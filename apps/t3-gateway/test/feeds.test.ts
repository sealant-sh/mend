import {
  WS_METHODS,
  type DeviceServiceState,
  type ScheduledTaskListResult,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { NO_DEVICE_HUB } from "../src/rpc.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer, t3Client } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * What a t3code client waits on before it renders a page, answered with what the gateway has
 * instead of silence: no scheduled tasks, a device hub that will never run, a client-activity
 * report taken; and the connection's own hygiene: the probe and the resume markers advertised.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const errorOf = (exit: Exit.Exit<unknown, unknown>): { _tag?: string; message?: string } => {
  if (!Exit.isFailure(exit)) return {};
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null ? error : {};
};

describe("feeds a page waits on", () => {
  it.live("the device hub is set up and failed, with why: t3code shows no setup wizard", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "DEVICES");
        const hub = yield* feed(rpc[WS_METHODS.subscribeDeviceState]({}));
        const state = yield* hub.next((_: DeviceServiceState): _ is DeviceServiceState => true);
        assert.deepStrictEqual(state, NO_DEVICE_HUB);
        // t3code opens its wizard for a hub not onboarded or disabled
        // (t3:apps/web/src/components/ChatView.tsx:5465 at the pin); this one is neither.
        assert.isTrue(state.onboardingCompleted);
        assert.notStrictEqual(state.hostStatus, "disabled");
        // The device panel shows the reason for a failed hub with no devices.
        assert.strictEqual(state.hostStatus, "failed");
        assert.lengthOf(state.devices, 0);
      }),
    ),
  );

  it.live("scheduled tasks are none, so a thread shows no automations section", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "TASKS");
        const tasks = yield* feed(rpc[WS_METHODS.scheduledTasksSubscribe]({}));
        const first = yield* tasks.next(
          (_: ScheduledTaskListResult): _ is ScheduledTaskListResult => true,
        );
        assert.deepStrictEqual(first, { tasks: [] });
        // Everything else about tasks is still refused, with the methods' own error.
        const list = yield* Effect.exit(rpc[WS_METHODS.scheduledTasksList]({}));
        assert.strictEqual(errorOf(list)._tag, "ScheduledTaskError");
      }),
    ),
  );

  it.live("resource telemetry is refused, never left loading: diagnostics are not granted", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "TELEMETRY");
        const exit = yield* Effect.exit(
          Stream.runHead(rpc[WS_METHODS.subscribeResourceTelemetry]({})).pipe(
            Effect.timeout("5 seconds"),
          ),
        );
        assert.strictEqual(errorOf(exit)._tag, "EnvironmentAuthorizationError");
        assert.include(errorOf(exit).message ?? "", "diagnostics:read");
      }),
    ),
  );
});

describe("connection hygiene", () => {
  it.live("takes a client-activity report, doing nothing", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "ACTIVITY");
        const before = mend.workbench.calls.length;
        yield* rpc[WS_METHODS.serverReportClientActivity]({
          clientId: "browser-1",
          clientKind: "web",
          visible: true,
          focused: true,
          recentlyInteracted: true,
          scopes: [{ type: "server-config" }],
          observedAt: DateTime.nowUnsafe(),
        });
        // Answered, and nothing in Mend changed (the hub's own reads go on).
        assert.isTrue(mend.workbench.calls.slice(before).every((call) => call.method === "GET"));
      }),
    ),
  );

  it.live("advertises the probe and the resume markers it honours", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const client = yield* t3Client;
        const descriptor = yield* client.metadata.descriptor();
        assert.isTrue(descriptor.capabilities.connectionProbe);
        const { rpc } = yield* pairAndConnect(mend, "PROBE");
        assert.deepStrictEqual(yield* rpc[WS_METHODS.serverProbe]({}), {});
        const config = yield* rpc[WS_METHODS.serverGetConfig]({});
        assert.isTrue(config.shellResumeCompletionMarker);
        assert.isTrue(config.threadResumeCompletionMarker);
      }),
    ),
  );
});
