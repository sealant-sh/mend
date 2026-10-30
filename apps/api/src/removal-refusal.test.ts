import { failedQuery } from "@mend/db/testing";
import { REMOVAL_START_REFUSED, REMOVAL_START_REFUSED_STOPPED } from "@mend/domain/workbench";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { refusedWhileRemoving } from "./removal-refusal.ts";

/** A session insert whose query failed as the driver reports `code`. */
const insertFailing = (code: string) =>
  Effect.die(
    failedQuery({
      query: "insert into agent_sessions",
      params: [],
      cause: { message: "refused", cause: { code } },
    }),
  );

const refusalOf = async (code: string) => {
  const exit = await Effect.runPromise(Effect.exit(refusedWhileRemoving(insertFailing(code))));
  return Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : null;
};

describe("a session start that met a removal's mark in the database", () => {
  it("answers RemovalInProgress for a removal at work", async () => {
    expect(await refusalOf("MRFEN")).toMatchObject({
      _tag: "Some",
      value: { _tag: "RemovalInProgress", message: REMOVAL_START_REFUSED },
    });
  });

  it("says a deletion that stopped partway is finished by removing it again", async () => {
    expect(await refusalOf("MRFES")).toMatchObject({
      _tag: "Some",
      value: { _tag: "RemovalInProgress", message: REMOVAL_START_REFUSED_STOPPED },
    });
  });

  it("leaves every other failure as it was", async () => {
    const exit = await Effect.runPromise(Effect.exit(refusedWhileRemoving(insertFailing("23505"))));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });
});
