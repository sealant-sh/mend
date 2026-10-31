import {
  type HarnessLayoutsMemoryState,
  linuxLoginNameOf,
  type SessionChannelTokensRepo,
} from "@mend/db";
import { defaultWorkspaceImage } from "@mend/domain";
import type { HarnessLayout } from "@mend/domain/workbench";
import {
  type PersonExecOptions,
  type PersonSessionOptions,
  SealantPlatformError,
  SealantClient,
} from "@mend/sealant";
import { ServiceHost, SessionEngine } from "@mend/sessions";
import type { CreateOptions, SessionOptions, Workspace } from "@sealant/sdk";
import { Effect, Layer } from "effect";

import { SCREEN_REKEYED } from "../../src/screen/script.ts";
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
  /** The argv of each process whose terminal Mend closed. */
  readonly closed: Array<ReadonlyArray<string>>;
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
    /** What the rekey script prints; its own last line unless set. */
    readonly rekeyPrinted?: ReadonlyArray<string>;
    /** The rekey script prints and then never ends. */
    readonly rekeyKeepsRunning?: boolean;
    readonly layout?: HarnessLayout;
    /** The recorded layouts, kept across the engines that boot over one world. */
    readonly layoutState?: HarnessLayoutsMemoryState;
    readonly tokensLayer?: Layer.Layer<SessionChannelTokensRepo>;
    readonly screen?: boolean;
    /** Give each new executor its own id when testing a stopped workspace. */
    readonly distinctWorkspaces?: boolean;
    /** A world the caller keeps; `restart` boots another engine over one an engine already set up. */
    readonly fixture?: { readonly world: World; readonly tmp: string };
    readonly restart?: boolean;
  } = {},
) => {
  const platform: Platform = {
    spawned: [],
    opened: [],
    execs: [],
    execUsers: [],
    listeners: [],
    closed: [],
  };
  const created: Array<CreateOptions> = [];
  return withPreparedEngineEffect(
    (world, tmp) => (options.restart === true ? Effect.void : setup(tmp, world)),
    (world) => work(world, platform),
    {
      captured: makeMemoryCaptureStore(),
      ...(options.fixture === undefined ? {} : { fixture: options.fixture }),
      ...(options.tokensLayer === undefined ? {} : { tokensLayer: options.tokensLayer }),
      workspaceImage: { ...defaultWorkspaceImage, screen: options.screen ?? true },
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
          closed: platform.closed,
          ptyKeepsRunning: (argv) =>
            argv[3] === "mend-screen-rekey" && options.rekeyKeepsRunning === true,
          exec: answerLayout(LAYOUT_READY),
          ptyOutput: (argv) => {
            if (argv[3] === "mend-screen") return options.printed ?? [];
            return argv[3] === "mend-screen-rekey"
              ? (options.rekeyPrinted ?? [SCREEN_REKEYED])
              : [];
          },
          ...(options.openFails === undefined ? {} : { openFails: options.openFails }),
          execEffect: (argv, execOptions) =>
            argv[3] === "mend-screen-reap" ? options.reap?.(argv, execOptions) : undefined,
          ...(options.aroundOpen === undefined ? {} : { aroundOpen: options.aroundOpen }),
        },
      ).pipe((base) =>
        Layer.effect(
          SealantClient,
          Effect.map(SealantClient, (client) => {
            if (options.distinctWorkspaces !== true) return client;
            const workspaces = new Map<string, Workspace>();
            return {
              ...client,
              createWorkspace: (...args) =>
                client.createWorkspace(...args).pipe(
                  Effect.map((workspace) => {
                    const handle = { ...workspace, id: `workspace-${workspaces.size + 1}` };
                    workspaces.set(handle.id, handle);
                    return handle;
                  }),
                ),
              getWorkspace: (id) => {
                const workspace = workspaces.get(id);
                return workspace === undefined
                  ? client.getWorkspace(id)
                  : Effect.succeed(workspace);
              },
            };
          }),
        ).pipe(Layer.provide(base)),
      ),
      harnessLayout: {
        flag: options.layout ?? "person",
        platform: personPlatform([], { person: true }),
        ...(options.layoutState === undefined ? {} : { state: options.layoutState }),
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
