import { linuxLoginNameOf, type SessionChannelTokensRepo } from "@mend/db";
import type { HarnessLayout } from "@mend/domain/workbench";
import {
  type PersonExecOptions,
  type PersonSessionOptions,
  SealantPlatformError,
} from "@mend/sealant";
import { ServiceHost, SessionEngine } from "@mend/sessions";
import type { CreateOptions, SessionOptions } from "@sealant/sdk";
import { Effect, Layer } from "effect";

import { makeMemoryCaptureStore } from "../capture-store-memory.ts";
import { sealantLaunchLayer, setup, withPreparedEngineEffect, type World } from "./fixture.ts";
import { answerLayout, LAYOUT_READY, personPlatform } from "./person-fixture.ts";

export const LAUNCHER = linuxLoginNameOf("user-fixture");

export const screenRows = (world: World) =>
  [...world.processes.values()].filter((process) => process.kind === "screen");

export interface Platform {
  readonly spawned: Array<ReadonlyArray<string>>;
  readonly opened: Array<PersonSessionOptions>;
  readonly execs: Array<ReadonlyArray<string>>;
  readonly execUsers: Array<string | null>;
  readonly listeners: Array<string>;
}

/** A person-layout launch of `claude` with a screen beside it, Xvnc's output scripted. */
export const withScreens = <A, E>(
  work: (world: World, platform: Platform) => Effect.Effect<A, E, SessionEngine>,
  options: {
    readonly openFails?: () => boolean;
    readonly aroundOpen?: (
      argv: ReadonlyArray<string>,
      options: SessionOptions | PersonSessionOptions | undefined,
    ) => Effect.Effect<void>;
    /** Stands in for a reap of a display; undefined falls through to the fake's exec. */
    readonly reap?: (
      argv: ReadonlyArray<string>,
      options: PersonExecOptions | undefined,
    ) => Effect.Effect<ExecAnswer, SealantPlatformError> | undefined;
    readonly printed?: ReadonlyArray<string>;
    readonly layout?: HarnessLayout;
    readonly tokensLayer?: Layer.Layer<SessionChannelTokensRepo>;
  } = {},
) => {
  const platform: Platform = { spawned: [], opened: [], execs: [], execUsers: [], listeners: [] };
  const created: Array<CreateOptions> = [];
  return withPreparedEngineEffect(
    (world, tmp) => setup(tmp, world),
    (world) => work(world, platform),
    {
      captured: makeMemoryCaptureStore(),
      ...(options.tokensLayer === undefined ? {} : { tokensLayer: options.tokensLayer }),
      sealantLayer: sealantLaunchLayer(
        created,
        undefined,
        undefined,
        platform.spawned,
        undefined,
        undefined,
        undefined,
        platform.opened,
        undefined,
        platform.execs,
        undefined,
        {
          execUsers: platform.execUsers,
          exec: answerLayout(LAYOUT_READY),
          ptyOutput: (argv) => (argv[3] === "mend-screen" ? (options.printed ?? []) : []),
          ...(options.openFails === undefined ? {} : { openFails: options.openFails }),
          execEffect: (argv, execOptions) =>
            argv[3] === "mend-screen-reap" ? options.reap?.(argv, execOptions) : undefined,
          ...(options.aroundOpen === undefined ? {} : { aroundOpen: options.aroundOpen }),
        },
      ),
      harnessLayout: {
        flag: options.layout ?? "person",
        platform: personPlatform([], { person: true }),
      },
      serviceHostLayer: Layer.succeed(ServiceHost, {
        bindAddresses: () => Effect.succeed(["127.0.0.1"]),
        start: (input) =>
          Effect.sync(() => {
            platform.listeners.push(String(input.serviceId));
            return { hostPort: 43127, boundAddresses: ["127.0.0.1"] };
          }),
        hold: () => Effect.void,
        sever: () => Effect.void,
        stop: () => Effect.void,
      }),
    },
  );
};

export interface ExecAnswer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const lostReap = new SealantPlatformError({
  code: "exec_failed",
  status: null,
  message: "the reap's answer was lost",
  cause: null,
});

export const lostStart = (failures: number) => {
  let failing = 0;
  return {
    arm: () => {
      failing = failures;
    },
    openFails: () => failing-- > 0,
  };
};

export const launched = (world: World) =>
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const [project] = [...world.projects.values()];
    if (project === undefined) throw new Error("no project");
    const session = yield* engine.provision({
      projectId: project.id,
      harness: "claude",
      label: null,
      name: "screen",
      ownerUserId: "user-fixture",
      start: { kind: "base", base: null },
    });
    yield* engine.launch(session.id, ["claude"]);
    return { engine, session };
  });
