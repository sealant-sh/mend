import { entityKind } from "drizzle-orm";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { Cause } from "effect";
import { SqlError } from "effect/sql";
import { describe, expect, it } from "vitest";

import { prettyCause } from "../src/query-parameters.ts";

const WORDS = "Rename the ledger helper before Friday 7c41";
const STATEMENT = 'insert into "agent_turns" ("id", "input") values ($1, $2)';

const refusedInsert = () =>
  new EffectDrizzleQueryError({
    query: STATEMENT,
    params: ["turn-1", WORDS],
    cause: Cause.fail(
      new SqlError.SqlError({
        reason: new SqlError.UnknownError({
          cause: new Error("admission refused by the test"),
          message: "PgConnection: Query failed",
        }),
      }),
    ),
  });

/** What a second copy of Drizzle raises: a query error of the same kind, from another class. */
class SecondCopyQueryError extends Error {
  static readonly [entityKind] = "EffectDrizzleQueryError";
  readonly query = STATEMENT;
  readonly params = ["turn-1", WORDS];
  constructor() {
    super(`Failed query: ${STATEMENT}\nparams: turn-1,${WORDS}`, { cause: refusedInsert().cause });
    this.name = "EffectDrizzleQueryError";
  }
}

describe("prettyCause", () => {
  it.each([
    ["a defect", () => Cause.die(refusedInsert())],
    ["a failure", () => Cause.fail(refusedInsert())],
    ["a defect from a second copy of Drizzle", () => Cause.die(new SecondCopyQueryError())],
    ["the cause of a defect", () => Cause.die(new Error("admission", { cause: refusedInsert() }))],
    [
      "a cause beneath a defect",
      () => Cause.die(new Error("admission", { cause: Cause.die(refusedInsert()) })),
    ],
    [
      "the cause of another failed query",
      () =>
        Cause.die(
          new EffectDrizzleQueryError({
            query: "commit",
            params: [],
            cause: Cause.fail(refusedInsert()),
          }),
        ),
    ],
  ])("withholds the parameters of a failed query found in %s", (_, cause) => {
    const original = cause();
    expect(Cause.pretty(original)).toContain(WORDS);
    const logged = prettyCause(original);
    expect(logged).not.toContain(WORDS);
    expect(logged).toContain(`Failed query: ${STATEMENT}`);
    expect(logged).toContain("params: 2 withheld");
    expect(logged).toContain("admission refused by the test");
  });

  it.each([
    ["an error's cause", () => Cause.die(new Error("EACCES", { cause: new Error("below") }))],
    [
      "a cause beneath a defect",
      () => Cause.die(new Error("EACCES", { cause: Cause.fail("below") })),
    ],
  ])("renders a cause with no failed query, in %s, as Cause.pretty does", (_, cause) => {
    const original = cause();
    expect(prettyCause(original)).toBe(Cause.pretty(original));
  });
});
