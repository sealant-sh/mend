import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WS_METHODS } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import { GRANTED_SCOPES } from "../src/auth.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { bearer, gatewayTestLayer, PERSON, t3Client, tokenRequest } from "./support/gateway.ts";
import { connectWsRpc, socketUrl } from "./support/rpc.ts";

const OLD_STANDARD = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "filesystem:read",
];

describe("the file-write pairing-scope upgrade", () => {
  it.live("upgrades an old standard pairing once and preserves deliberately different grants", () =>
    Effect.gen(function* () {
      const path = join(mkdtempSync(join(tmpdir(), "t3-gateway-scope-upgrade-")), "state.sqlite");
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      const grants = [
        { label: "standard", scopes: OLD_STANDARD.toReversed() },
        ...OLD_STANDARD.map((omitted) => ({
          label: `without-${omitted}`,
          scopes: OLD_STANDARD.filter((scope) => scope !== omitted),
        })),
        { label: "different", scopes: [...OLD_STANDARD, "diagnostics:read"] },
      ];
      const paired = yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* t3Client;
          return yield* Effect.forEach(grants, (grant) =>
            Effect.gen(function* () {
              mend.addPairingCode(grant.label, PERSON);
              const access = yield* client.auth.token(
                tokenRequest(grant.label, { client_label: grant.label }),
              );
              return { ...grant, access };
            }),
          );
        }).pipe(Effect.provide(gatewayTestLayer(mend.url, path))),
      );

      // Recreate grants stored by the gateway before file writes were supported.
      const old = new DatabaseSync(path);
      for (const grant of grants) {
        old
          .prepare("UPDATE bearer_sessions SET scopes = ? WHERE client_label = ?")
          .run(JSON.stringify(grant.scopes), grant.label);
      }
      old.exec("PRAGMA user_version = 23");
      old.close();

      const check = Effect.gen(function* () {
        const migrated = new DatabaseSync(path);
        for (const grant of grants) {
          assert.strictEqual(
            migrated
              .prepare("SELECT scopes FROM bearer_sessions WHERE client_label = ?")
              .get(grant.label)?.scopes,
            JSON.stringify(
              grant.label === "standard"
                ? [
                    ...grant.scopes,
                    "filesystem:write",
                    ...GRANTED_SCOPES.filter(
                      (scope) => scope !== "filesystem:write" && !OLD_STANDARD.includes(scope),
                    ),
                  ]
                : grant.scopes,
            ),
          );
        }
        migrated.close();
        const client = yield* t3Client;
        for (const grant of paired) {
          const session = yield* client.auth.session({
            headers: bearer(grant.access.access_token),
          });
          assert.strictEqual(
            session.permissions?.includes("filesystem:write"),
            grant.label === "standard",
          );
          const ticket = yield* client.auth.webSocketTicket({
            headers: bearer(grant.access.access_token),
          });
          const rpc = yield* connectWsRpc(yield* socketUrl(ticket.ticket));
          const saved = yield* Effect.result(
            rpc[WS_METHODS.projectsWriteFile]({
              cwd: "/var/lib/mend/store/project-1/worktrees/wt-session-1",
              relativePath: "README.md",
              contents: "- [x] Saved with an existing pairing\n",
            }),
          );
          if (grant.label === "standard") {
            assert.strictEqual(saved._tag, "Success");
            const file = yield* rpc[WS_METHODS.projectsReadFile]({
              cwd: "/var/lib/mend/store/project-1/worktrees/wt-session-1",
              relativePath: "README.md",
            });
            assert.strictEqual(file.contents, "- [x] Saved with an existing pairing\n");
          } else {
            assert.strictEqual(saved._tag, "Failure");
            if (saved._tag === "Failure") {
              assert.strictEqual(saved.failure._tag, "EnvironmentAuthorizationError");
              if (saved.failure._tag === "EnvironmentAuthorizationError") {
                assert.strictEqual(saved.failure.requiredPermission, "filesystem:write");
              }
            }
          }
        }
      });
      yield* Effect.scoped(check.pipe(Effect.provide(gatewayTestLayer(mend.url, path))));

      // A later pairing asking for the old set must stay narrow across future restarts.
      const current = new DatabaseSync(path);
      current
        .prepare("UPDATE bearer_sessions SET scopes = ? WHERE client_label = 'standard'")
        .run(JSON.stringify(OLD_STANDARD));
      current.close();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* t3Client;
          const standard = paired.find((grant) => grant.label === "standard");
          assert.isDefined(standard);
          if (standard === undefined) return;
          const session = yield* client.auth.session({
            headers: bearer(standard.access.access_token),
          });
          assert.notInclude(session.permissions ?? [], "filesystem:write");
        }).pipe(Effect.provide(gatewayTestLayer(mend.url, path))),
      );
    }),
  );
});
