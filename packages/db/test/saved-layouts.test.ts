import { PgClient } from "@effect/sql-pg";
import { SAVED_LAYOUT_LIMITS, TileLayout } from "@mend/domain/workbench";
import { Effect, Exit, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SavedLayoutsRepo, SavedLayoutsRepoLive } from "../src/repos/saved-layouts.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_saved_layouts_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = SavedLayoutsRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SavedLayoutsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));
const exit = <A, E>(effect: Effect.Effect<A, E, SavedLayoutsRepo | SqlClient.SqlClient>) =>
  run(Effect.exit(effect));
const failureTag = (result: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(result) && result.cause.reasons[0]?._tag === "Fail"
    ? result.cause.reasons[0].error._tag
    : null;

const layout = Schema.decodeUnknownSync(TileLayout);
const reviewWithTerminal = layout({
  version: 1,
  root: {
    kind: "split",
    direction: "column",
    children: [
      { kind: "tile", tabs: [{ kind: "view", view: "change" }], active: 0 },
      { kind: "tile", tabs: [{ kind: "view", view: "terminal" }], active: 0 },
    ],
    sizes: [60, 40],
  },
  focus: 0,
});
const conversationOnly = layout({
  version: 1,
  root: { kind: "tile", tabs: [{ kind: "session" }], active: 0 },
  focus: 0,
});

describe.skipIf(postgres.skip)("saved layouts, in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES
            ('anna', 'Anna Example', 'anna@example.com', '2026-01-01T00:00:00Z'),
            ('ben', 'Ben Example', 'ben@example.com', '2026-01-01T00:00:00Z'),
            ('cleo', 'Cleo Example', 'cleo@example.com', '2026-01-01T00:00:00Z'),
            ('dana', 'Dana Example', 'dana@example.com', '2026-01-01T00:00:00Z'),
            ('eli', 'Eli Example', 'eli@example.com', '2026-01-01T00:00:00Z'),
            ('fay', 'Fay Example', 'fay@example.com', '2026-01-01T00:00:00Z'),
            ('gus', 'Gus Example', 'gus@example.com', '2026-01-01T00:00:00Z'),
            ('hal', 'Hal Example', 'hal@example.com', '2026-01-01T00:00:00Z')`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("lists a person's own layouts oldest first, each reading back as it was saved", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SavedLayoutsRepo;
        yield* repo.save("anna", { name: "Review with terminal", layout: reviewWithTerminal });
        yield* repo.save("anna", { name: "Just talk", layout: conversationOnly });
        yield* repo.save("ben", { name: "Ben's own", layout: conversationOnly });
        return yield* repo.list("anna");
      }),
    );
    expect(result.map((saved) => [saved.name, saved.layout])).toEqual([
      ["Review with terminal", reviewWithTerminal],
      ["Just talk", conversationOnly],
    ]);
  });

  it("refuses a name the person already uses in any case, while someone else may use it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SavedLayoutsRepo;
        yield* repo.save("cleo", { name: "Review", layout: reviewWithTerminal });
        const again = yield* Effect.exit(
          repo.save("cleo", { name: "REVIEW", layout: conversationOnly }),
        );
        const someoneElse = yield* Effect.exit(
          repo.save("dana", { name: "review", layout: conversationOnly }),
        );
        return { again, someoneElse, cleo: yield* repo.list("cleo") };
      }),
    );
    expect(failureTag(result.again)).toBe("SavedLayoutNameTakenError");
    expect(Exit.isSuccess(result.someoneElse)).toBe(true);
    expect(result.cleo.map((saved) => saved.layout)).toEqual([reviewWithTerminal]);
  });

  it("keeps at most the limit per person, and one person's count never limits another", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SavedLayoutsRepo;
        for (let n = 1; n <= SAVED_LAYOUT_LIMITS.layouts; n += 1) {
          yield* repo.save("eli", { name: `Layout ${n}`, layout: conversationOnly });
        }
        const past = yield* Effect.exit(
          repo.save("eli", { name: "One too many", layout: conversationOnly }),
        );
        return { past, eli: yield* repo.list("eli") };
      }),
    );
    expect(failureTag(result.past)).toBe("SavedLayoutLimitError");
    expect(result.eli).toHaveLength(SAVED_LAYOUT_LIMITS.layouts);
    expect(result.eli.map((saved) => saved.name)).not.toContain("One too many");
    const forFay = await exit(
      Effect.flatMap(SavedLayoutsRepo, (repo) =>
        repo.save("fay", { name: "Fay's first", layout: reviewWithTerminal }),
      ),
    );
    expect(Exit.isSuccess(forFay)).toBe(true);
  });

  it("renames only the name, to anything but another of the person's names", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SavedLayoutsRepo;
        const first = yield* repo.save("gus", { name: "Wide", layout: reviewWithTerminal });
        yield* repo.save("gus", { name: "Narrow", layout: conversationOnly });
        const ownCase = yield* repo.rename("gus", first.id, "WIDE");
        const taken = yield* Effect.exit(repo.rename("gus", first.id, "narrow"));
        const renamed = yield* repo.rename("gus", first.id, "Wide review");
        return { first, ownCase, taken, renamed };
      }),
    );
    expect(result.ownCase.name).toBe("WIDE");
    expect(failureTag(result.taken)).toBe("SavedLayoutNameTakenError");
    expect(result.renamed).toMatchObject({
      id: result.first.id,
      name: "Wide review",
      layout: reviewWithTerminal,
    });
  });

  it("never renames or removes another person's layout", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SavedLayoutsRepo;
        const cleos = yield* repo.save("cleo", { name: "Cleo's", layout: conversationOnly });
        const renamed = yield* Effect.exit(repo.rename("dana", cleos.id, "Mine now"));
        const removedByOther = yield* repo.remove("dana", cleos.id);
        const kept = yield* repo.list("cleo");
        const removedByOwner = yield* repo.remove("cleo", cleos.id);
        return {
          cleos,
          renamed,
          removedByOther,
          kept,
          removedByOwner,
          after: yield* repo.list("cleo"),
        };
      }),
    );
    expect(failureTag(result.renamed)).toBe("SavedLayoutNotFoundError");
    expect(result.removedByOther).toBe(false);
    expect(result.kept.map((saved) => saved.name)).toContain("Cleo's");
    expect(result.removedByOwner).toBe(true);
    expect(result.after.map((saved) => saved.id)).not.toContain(result.cleos.id);
  });

  it("leaves out a layout this Mend can't read, and still lists the rest", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* SavedLayoutsRepo;
        yield* sql`
          INSERT INTO user_saved_layouts (id, user_id, name, layout)
          VALUES ('from-later', 'hal', 'From a later Mend', '{"version": 2, "panes": []}'::jsonb)`;
        yield* repo.save("hal", { name: "Readable", layout: conversationOnly });
        const listed = yield* repo.list("hal");
        const removed = yield* repo.remove("hal", "from-later");
        return { listed, removed };
      }),
    );
    expect(result.listed.map((saved) => saved.name)).toEqual(["Readable"]);
    expect(result.removed).toBe(true);
  });
});
