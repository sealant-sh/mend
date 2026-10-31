import { DopplerRepo, linuxLoginNameOf } from "@mend/db";
import { ProjectId, SessionId } from "@mend/domain";
import { DOPPLER_CONFIG_PATH, Session } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { commandOf } from "./engine-person-runtime-fixtures.ts";
import { lifecycleLayer } from "./engine/capture-fixture.ts";
import {
  isPickupExec,
  redeemPickupExec,
  recordingProtocolHostLayer,
  servedSocketApis,
  setup,
  withEngine,
} from "./engine/fixture.ts";
import { answerLayout, LAYOUT_READY, MARIA, personPlatform } from "./engine/person-fixture.ts";
import { secretForms } from "./pickup-channel.ts";

const tokens = {
  "user-fixture": "dp.ct.fake-launcher-canary",
  [MARIA]: "dp.st.fake-steerer-canary",
};
const tokenFor = (person: string) => tokens[person === MARIA ? MARIA : "user-fixture"];

describe("Doppler launch through personal secret-file delivery", () => {
  it("delivers person-bound configs as their own Linux user, follows the steerer, never records bytes and never calls Doppler", async () => {
    const created: Array<CreateOptions> = [],
      execs: Array<ReadonlyArray<string>> = [],
      users: Array<string | null> = [],
      logs: Array<string> = [],
      tokenEvents: Array<string> = [];
    const delivered: Array<{ person: string; contents: string }> = [];
    let active: SessionId | null = null,
      projectId = ProjectId.make("unknown");
    const dopplerLayer = Layer.mock(DopplerRepo, {
      connection: (person) =>
        Effect.succeed({ sealedToken: `sealed:${tokenFor(person)}`, updatedAt: new Date(0) }),
      mappings: (person) =>
        Effect.succeed([
          {
            projectId,
            dopplerProject: "backend",
            config: person === MARIA ? "dev_maria" : "dev_launcher",
          },
        ]),
    });
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          projectId = project.id;
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          active = session.id;
          yield* engine.launch(session.id, ["codex"]);
          const steered = yield* engine.provisionSessionIn(session.worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          active = steered.id;
          world.sessions.set(
            steered.id,
            new Session({ ...steered, sharedControlEnabledAt: new Date() }),
          );
          yield* engine.launchProtocol(
            steered.id,
            { mode: "protocol", prompt: "follow up" },
            MARIA,
          );
          expect(delivered.map((item) => item.person)).toContain("user-fixture");
          expect(delivered.map((item) => item.person)).toContain(MARIA);
          for (const item of delivered) {
            const parsed = JSON.parse(item.contents);
            expect(parsed.scoped["/"].token).toBe(tokenFor(item.person));
            expect(parsed.scoped["/workspace/repo"]).toEqual({
              "enclave.project": "backend",
              "enclave.config": item.person === MARIA ? "dev_maria" : "dev_launcher",
            });
          }
          const recorded = JSON.stringify({ created, execs, logs });
          for (const token of Object.values(tokens))
            for (const form of secretForms(new TextEncoder().encode(token)))
              expect(recorded).not.toContain(form);
          expect(created[0]?.packages).toContain("doppler");
          expect(
            execs.some(
              (argv, i) => isPickupExec(commandOf(argv)) && users[i] === linuxLoginNameOf(MARIA),
            ),
          ).toBe(true);
          const api = servedSocketApis.get(steered.id);
          const launch = tokenEvents
            .findLast((event) => event.startsWith("issue:"))
            ?.slice("issue:".length);
          expect(launch).toBeDefined();
          if (launch !== undefined) {
            const grant = yield* (
              api?.channelFor?.({ launchId: launch, accountId: MARIA }) ?? Effect.die("no channel")
            );
            expect(grant.ok).toBe(true);
            if (grant.ok) {
              const status = yield* (
                grant.api.doppler?.({ action: "status" }) ?? Effect.die("no Doppler route")
              );
              expect(JSON.stringify(status)).not.toContain(tokens["user-fixture"]);
              expect(JSON.stringify(status)).not.toContain(tokens[MARIA]);
              expect(status).toMatchObject({
                connected: true,
                mappings: [{ config: "dev_maria" }],
              });
            }
          }
        }),
      {
        captured: makeMemoryCaptureStore(),
        dopplerLayer,
        protocolHostLayer: recordingProtocolHostLayer([], []),
        logs,
        tokenEvents,
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: lifecycleLayer(created, {
          execCalls: execs,
          captureOps: {
            execUsers: users,
            exec: (argv) => {
              if (
                (argv[2] ?? "").includes("leftover()") ||
                (argv[2] ?? "").includes("nothing is staged for this conversation")
              )
                return {
                  exitCode: 0,
                  stdout: "mend-conv empty\nmend-conv exchanged first\n",
                  stderr: "",
                };
              return answerLayout(LAYOUT_READY + `mend-layout made ${linuxLoginNameOf(MARIA)}\n`)(
                argv,
              );
            },
            execEffect: (argv, options) => {
              const command = commandOf(argv);
              if (!isPickupExec(command) || command[3] !== "mend-secret-files") return undefined;
              const person =
                options?.user?.name === linuxLoginNameOf(MARIA) ? MARIA : "user-fixture";
              const launch =
                tokenEvents
                  .findLast((event) => event.startsWith("issue:"))
                  ?.slice("issue:".length) ?? null;
              return redeemPickupExec(command, active, launch, person).pipe(
                Effect.map((answer) => {
                  for (const file of answer.files)
                    if (file.path === DOPPLER_CONFIG_PATH)
                      delivered.push({
                        person,
                        contents: Buffer.from(file.base64, "base64").toString("utf8"),
                      });
                  return {
                    exitCode: 0,
                    stdout: answer.files.map((file) => `written\t${file.path}\n`).join(""),
                    stderr: "",
                  };
                }),
                Effect.orDie,
              );
            },
          },
        }),
        harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
      },
    );
  });
});
