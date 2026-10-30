import { type AgentConversationRepo } from "@mend/db";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMISSION_REFUSED, refusedAdmissions } from "../../test/support/refused-admissions.ts";
import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";
import type { ErrorDetail } from "../error-boundary.ts";

const shared = ids("shared-a");
const admissions = refusedAdmissions(shared);

const boundaryLog = (logs: ReadonlyArray<string>): string => {
  const line = logs.find((entry) =>
    entry.includes("an unhandled failure reached the error boundary"),
  );
  if (line === undefined) throw new Error(`no boundary log among ${logs.length} lines`);
  return line;
};

describe.skipIf(admissions.skip)("a refused insert at the boundary, the engine stubbed", () => {
  let conversations: AgentConversationRepo["Service"];
  beforeAll(async () => {
    conversations = await admissions.open();
  }, 120_000);
  afterAll(() => admissions.close());

  const serve = (mode: ErrorDetail["Service"]["mode"], logs: string[]) =>
    createTenancyApi(
      {},
      {
        logs,
        errorDetail: { mode },
        implement: {
          engine: {
            launchUnderWay: () => false,
            submitTurn: (sessionId, input, author) =>
              conversations.submitTurn(sessionId, shared.process, input, author).pipe(Effect.orDie),
            steerTurn: (input) =>
              conversations
                .admitTurnSteer({
                  turnId: input.turnId,
                  author: input.sender,
                  input: input.input,
                  clientSteerId: input.clientSteerId ?? null,
                })
                .pipe(
                  Effect.map((admitted) => admitted.steer),
                  Effect.orDie,
                ),
          },
        },
      },
    );

  describe.each(["redacted", "verbose"] as const)("MEND_ERROR_DETAIL=%s", (mode) => {
    it.each([
      {
        route: "POST /api/sessions/:id/turns",
        path: `/api/sessions/${shared.session}/turns`,
        words: "Rename the ledger helper before Friday 7c41",
        body: (words: string) => ({ input: words }),
        statement: 'insert into \\"agent_turns\\"',
      },
      {
        route: "POST /api/turns/:id/steer",
        path: `/api/turns/${shared.turn}/steer`,
        words: "Keep the ledger helper private 9e02",
        body: (words: string) => ({ input: words, clientSteerId: crypto.randomUUID() }),
        statement: 'insert into \\"agent_turn_steers\\"',
      },
    ])("$route logs the failed statement without the words", async (route) => {
      const logs: string[] = [];
      const api = await serve(mode, logs);
      try {
        const response = await api.request("alice", "POST", route.path, route.body(route.words));
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ _tag: "InternalError" });
        const logged = boundaryLog(logs);
        expect(logged).toContain(route.statement);
        expect(logged).toContain(ADMISSION_REFUSED);
        expect(logs.join("\n")).not.toContain(route.words);
      } finally {
        await api.dispose();
      }
    });
  });
});
