import { SessionId } from "@mend/domain";
import { Session } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionsRepo } from "../src/repos/agent-sessions.ts";
import { createLivePeopleFixture } from "./session-live-people-fixture.ts";

const { postgres, run, setup, teardown } = createLivePeopleFixture();

describe.skipIf(postgres.skip)("session purpose persistence and views", () => {
  beforeAll(setup);
  afterAll(teardown);

  it("round trips a setup purpose through creation, ordinary reads and API views", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const source = yield* sessions.byId(SessionId.make("s-alice"));
        const created = yield* sessions.create({
          ...source,
          id: SessionId.make("s-setup"),
          baseRef: "main",
          purpose: "setup",
        });
        const plain = yield* sessions.byId(created.id);
        const view = yield* sessions.viewById(created.id);
        const project = yield* sessions.listForProject(created.projectId);
        const active = yield* sessions.listActiveView();
        for (const session of [
          created,
          plain,
          view,
          project.find((row) => row.id === created.id),
          active.find((row) => row.id === created.id),
        ]) {
          expect(session?.purpose).toBe("setup");
          if (session !== undefined)
            expect(Schema.encodeSync(Session)(session).purpose).toBe("setup");
        }
        expect(source.purpose).toBeNull();
      }),
    );
  });

  it("does not warm a hot pool for someone who has only started a setup session", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const source = yield* sessions.byId(SessionId.make("s-alice"));
        const input = {
          ...source,
          baseRef: "main",
          ownerUserId: "setup-only",
          label: "A person's own setup label",
        };
        yield* sessions.create({ ...input, id: SessionId.make("s-setup-only"), purpose: "setup" });
        const owners = () =>
          sessions.recentOwnersForProject(source.projectId, new Date(0), "install · mend");
        expect(yield* owners()).not.toContain("setup-only");
        yield* sessions.create({ ...input, id: SessionId.make("s-ordinary"), purpose: null });
        expect(yield* owners()).toContain("setup-only");
      }),
    );
  });
});
