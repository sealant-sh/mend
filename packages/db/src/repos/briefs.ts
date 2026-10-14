import { PgClient } from "@effect/sql-pg";
import {
  Brief,
  BriefDocument,
  BriefId,
  BriefVersion,
  ReviewQuestionId,
  type ChangeId,
} from "@mend/domain";
import { desc, eq, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { briefVersions, briefs, changes, reviewQuestions } from "../schema/workbench.ts";

export class BriefNotFoundError extends Schema.TaggedErrorClass<BriefNotFoundError>()(
  "BriefNotFoundError",
  {
    changeId: Schema.String,
  },
) {}

const decodeBrief = Schema.decodeUnknownEffect(Brief);
const decodeVersion = Schema.decodeUnknownEffect(BriefVersion);
const encodeDocument = Schema.encodeEffect(BriefDocument);

/**
 * The living document (ARCHITECTURE.md §3): one brief per change, replaced
 * whole on every publish, prior versions kept so "what did the brief claim
 * when I approved" stays answerable. Documents are stored encoded (sequences
 * as decimal strings) — readable without a Sealant round-trip, forever.
 */
export class BriefsRepo extends Context.Service<
  BriefsRepo,
  {
    readonly byChange: (changeId: ChangeId) => Effect.Effect<Brief, BriefNotFoundError>;
    readonly versions: (changeId: ChangeId) => Effect.Effect<ReadonlyArray<BriefVersion>>;
    /** Replaces the living brief; the review questions index follows the document. */
    readonly publish: (
      changeId: ChangeId,
      document: BriefDocument,
    ) => Effect.Effect<{ readonly version: number }>;
  }
>()("@mend/db/BriefsRepo") {}

const decodeBriefRow = (row: typeof briefs.$inferSelect) =>
  decodeBrief(row).pipe(
    Effect.map((decoded) => new Brief(decoded)),
    Effect.orDie,
  );

const decodeVersionRow = (row: typeof briefVersions.$inferSelect) =>
  decodeVersion(row).pipe(
    Effect.map((decoded) => new BriefVersion(decoded)),
    Effect.orDie,
  );

export const BriefsRepoLive: Layer.Layer<BriefsRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    BriefsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const pg = yield* PgClient.PgClient;

      const issueIdOf = Effect.fn("BriefsRepo.issueIdOf")(function* (changeId: ChangeId) {
        const [row] = yield* db
          .select({ issueId: changes.issueId })
          .from(changes)
          .where(eq(changes.id, changeId))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.issueId ?? "";
      });

      const byChange = Effect.fn("BriefsRepo.byChange")(function* (changeId: ChangeId) {
        const [row] = yield* db
          .select()
          .from(briefs)
          .where(eq(briefs.changeId, changeId))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new BriefNotFoundError({ changeId });
        return yield* decodeBriefRow(row);
      });

      const versions = Effect.fn("BriefsRepo.versions")(function* (changeId: ChangeId) {
        const rows = yield* db
          .select({ version: briefVersions })
          .from(briefVersions)
          .innerJoin(briefs, eq(briefs.id, briefVersions.briefId))
          .where(eq(briefs.changeId, changeId))
          .orderBy(desc(briefVersions.version))
          .pipe(Effect.orDie);
        return yield* Effect.forEach(rows, ({ version }) => decodeVersionRow(version));
      });

      const publish = Effect.fn("BriefsRepo.publish")(function* (
        changeId: ChangeId,
        document: BriefDocument,
      ) {
        const encoded = yield* encodeDocument(document).pipe(Effect.orDie);
        const briefId = BriefId.make(crypto.randomUUID());

        const version = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [row] = yield* tx
                .insert(briefs)
                .values({ id: briefId, changeId, currentVersion: 1, document: encoded })
                .onConflictDoUpdate({
                  target: briefs.changeId,
                  set: {
                    currentVersion: sql`${briefs.currentVersion} + 1`,
                    document: encoded,
                    updatedAt: yield* DateTime.nowAsDate,
                  },
                })
                .returning({ id: briefs.id, currentVersion: briefs.currentVersion });
              if (row === undefined) return yield* Effect.die("brief upsert returned no row");

              yield* tx.insert(briefVersions).values({
                briefId: row.id,
                version: row.currentVersion,
                document: encoded,
              });

              // The index over the document's questions — replaced with it.
              yield* tx.delete(reviewQuestions).where(eq(reviewQuestions.briefId, row.id));
              for (const question of encoded.questions) {
                yield* tx.insert(reviewQuestions).values({
                  id: ReviewQuestionId.make(crypto.randomUUID()),
                  briefId: row.id,
                  index: question.index,
                  question: question.question,
                  disposition: question.disposition,
                  evidence: question.evidence,
                });
              }

              return row.currentVersion;
            }),
          )
          .pipe(Effect.orDie);

        const issueId = yield* issueIdOf(changeId);
        yield* notifyEvent(pg, { type: "brief", changeId, issueId });
        return { version };
      });

      return { byChange, versions, publish };
    }),
  );
