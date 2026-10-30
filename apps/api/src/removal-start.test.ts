import { failedQuery } from "@mend/db/testing";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { refusedWhileRemoving } from "./removal.ts";

/** A session insert whose query failed as the driver reports `code`. */
const insertFailing = (code: string) =>
  Effect.die(
    failedQuery({
      query: "insert into agent_sessions",
      params: [],
      cause: { message: "refused", cause: { code } },
    }),
  );

describe("a session start that met a removal's mark in the database", () => {
  it("answers RemovalInProgress for the trigger's refusal", async () => {
    const exit = await Effect.runPromise(Effect.exit(refusedWhileRemoving(insertFailing("MRFEN"))));
    expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : null).toMatchObject({
      _tag: "Some",
      value: { _tag: "RemovalInProgress" },
    });
  });

  it("leaves every other failure as it was", async () => {
    const exit = await Effect.runPromise(Effect.exit(refusedWhileRemoving(insertFailing("23505"))));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });
});
