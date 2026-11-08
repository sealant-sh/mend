import { piProfileDigest } from "@mend/db";
import { SessionId } from "@mend/domain";
import { PiProfile } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { lifecycleLayer } from "./engine/capture-fixture.ts";
import {
  isPickupExec,
  piProfilesLayerOf,
  redeemPickupExec,
  secretFilesLayerOf,
  setup,
  withEngine,
} from "./engine/fixture.ts";
import { secretForms } from "./pickup-channel.ts";

describe("no secret rides an exec's arguments (review of mend#552/#553, P1-1)", () => {
  // Core keeps every exec's argv, in plaintext, for good. A person's secret files and their pi
  // profile (its `mcp.json` holds their MCP servers' keys) reach the executor through a pickup
  // ticket redeemed over the session channel; only the ticket and the paths ride the argv.
  it("a pi launch delivers the owner's secret files and pi profile, and no byte of either reaches the platform's argv", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const tokenEvents: Array<string> = [];
    const secrets: Record<string, string> = {
      ".aws/credentials":
        "[default]\naws_access_key_id = AKIAEXAMPLE0SECRET01\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
      ".npmrc": "//registry.npmjs.org/:_authToken=npm_0123456789abcdefghijklmnopqrstuvwxyz\n",
    };
    const mcp = JSON.stringify({
      mcpServers: {
        linear: { headers: { Authorization: "Bearer lin_api_0123456789abcdefSECRET" } },
      },
    });
    const profileFiles = [
      { path: "root/mcp.json", encoding: "utf8", contents: mcp },
      {
        path: "extensions/git-info/index.ts",
        encoding: "utf8",
        contents: "export default () => {};\n",
      },
    ] as const;
    const known = [...Object.values(secrets), mcp].map((text) => new TextEncoder().encode(text));
    // What each redemption answered, by purpose of the exec that carried it.
    const picked = new Map<
      string,
      ReadonlyArray<{ readonly path: string; readonly base64: string }>
    >();
    let sessionId: SessionId | null = null;
    const launchOf = () => {
      const issued = tokenEvents.findLast((event) => event.startsWith("issue:"));
      return issued === undefined ? null : issued.slice("issue:".length);
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "pi",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          sessionId = session.id;
          yield* engine.launch(session.id, ["pi"]);

          // Both deliveries happened, each in one exec, and each redeemed exactly what it carries.
          const secretExecs = execCalls.filter(
            (argv) => argv[3] === "mend-secret-files" && isPickupExec(argv),
          );
          const profileExecs = execCalls.filter(
            (argv) => argv[3] === "mend-write" && isPickupExec(argv),
          );
          expect(secretExecs).toHaveLength(1);
          expect(profileExecs).toHaveLength(1);
          expect(
            (picked.get("mend-secret-files") ?? []).map((file) => [
              file.path,
              Buffer.from(file.base64, "base64").toString("utf8"),
            ]),
          ).toEqual(Object.entries(secrets));
          const profile = new Map(
            (picked.get("mend-write") ?? []).map((file) => [
              file.path,
              Buffer.from(file.base64, "base64").toString("utf8"),
            ]),
          );
          expect(profile.get("/workspace/harness-home/.pi/agent/mend/profile/root/mcp.json")).toBe(
            mcp,
          );

          // Not one form of a secret anywhere the platform keeps: no exec argv, no agent argv,
          // no create request.
          const everything = [
            ...execCalls.map((argv) => argv.join("\u0000")),
            ...spawned.map((argv) => argv.join("\u0000")),
            ...created.map((options) => JSON.stringify(options)),
          ].join("\n");
          for (const bytes of known) {
            for (const form of secretForms(bytes)) expect(everything).not.toContain(form);
          }
          // The tickets that did ride the argv are spent: none redeems again.
          for (const argv of [...secretExecs, ...profileExecs]) {
            const again = yield* redeemPickupExec(argv, session.id, launchOf()).pipe(Effect.flip);
            expect(again.message).toBe(
              "this pickup ticket was already redeemed, perhaps through another channel",
            );
          }
        }),
      {
        captured: makeMemoryCaptureStore(),
        tokenEvents,
        sealantLayer: lifecycleLayer(created, {
          spawned,
          execCalls,
          captureOps: {
            execEffect: (argv) => {
              if (!isPickupExec(argv)) return undefined;
              const purpose = argv[3] ?? "";
              const launch = launchOf();
              // Another executor's launch is refused, and spends nothing it can use: the
              // ticket is taken by the first presentation, so only the right channel asks.
              return redeemPickupExec(argv, sessionId, launch).pipe(
                Effect.map((answer) => {
                  picked.set(purpose, answer.files);
                  return {
                    exitCode: 0,
                    stdout:
                      purpose === "mend-secret-files"
                        ? answer.files.map((file) => `written\t${file.path}\n`).join("")
                        : "",
                    stderr: "",
                  };
                }),
                Effect.orDie,
              );
            },
          },
        }),
        secretFilesLayer: secretFilesLayerOf(() =>
          Effect.succeed(
            Object.entries(secrets).map(([at, text]) => ({
              path: at,
              sealedContents: `sealed:${Buffer.from(text, "utf8").toString("base64")}`,
            })),
          ),
        ),
        piProfilesLayer: piProfilesLayerOf(() =>
          Effect.succeed({
            profile: new PiProfile({
              fileCount: profileFiles.length,
              bytes: profileFiles.reduce((sum, file) => sum + file.contents.length, 0),
              extensions: ["git-info"],
              packages: [],
              digest: piProfileDigest(profileFiles),
              revision: 1,
              updatedAt: new Date(0),
            }),
            files: profileFiles,
          }),
        ),
      },
    );
  });

  it("a ticket redeemed through another executor's launch answers nothing, and is spent", async () => {
    const created: Array<CreateOptions> = [];
    const tokenEvents: Array<string> = [];
    const answers: Array<string> = [];
    const logs: Array<string> = [];
    let sessionId: SessionId | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          sessionId = session.id;
          yield* engine.launch(session.id, ["codex"]);
          expect(answers).toEqual([
            "refused: this pickup ticket is another executor's",
            "refused: this pickup ticket was already redeemed, perhaps through another channel",
          ]);
          // Both refusals read as a possible theft, and neither names the ticket.
          expect(
            logs.filter((line) => line.startsWith("session engine: pickup refused")),
          ).toHaveLength(2);
          // The refusal is logged by path, and no byte of the file is in any line.
          expect(logs).toContain("session engine: secret file · not written");
          expect(logs.join("\n")).not.toContain("npm_secret_value_01");
        }),
      {
        captured: makeMemoryCaptureStore(),
        tokenEvents,
        logs,
        sealantLayer: lifecycleLayer(created, {
          execCalls: [],
          captureOps: {
            execEffect: (argv) => {
              if (argv[3] !== "mend-secret-files" || !isPickupExec(argv)) return undefined;
              const issued = tokenEvents.findLast((event) => event.startsWith("issue:"));
              const launch = issued === undefined ? null : issued.slice("issue:".length);
              expect(launch).not.toBeNull();
              const attempt = (as: string | null) =>
                redeemPickupExec(argv, sessionId, as).pipe(
                  Effect.match({
                    onFailure: (error) => answers.push(`refused: ${error.message}`),
                    onSuccess: () => answers.push("answered"),
                  }),
                );
              return attempt("launch-of-another-executor").pipe(
                Effect.andThen(attempt(launch)),
                Effect.as({
                  exitCode: 0,
                  stdout:
                    "refused\t.npmrc\tthe pickup was refused: this pickup ticket is spent, expired or unknown\n",
                  stderr: "",
                }),
              );
            },
          },
        }),
        secretFilesLayer: secretFilesLayerOf(() =>
          Effect.succeed([
            {
              path: ".npmrc",
              sealedContents: `sealed:${Buffer.from("//r/:_authToken=npm_secret_value_01", "utf8").toString("base64")}`,
            },
          ]),
        ),
      },
    );
  });
});
