import { SavedLayoutId } from "@mend/domain";
import { SAVED_LAYOUT_LIMITS, SavedLayout, TileLayout } from "@mend/domain/workbench";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { userSavedLayouts } from "../schema/workbench.ts";

/** Another of the person's layouts has this name, ignoring case. */
export class SavedLayoutNameTakenError extends Schema.TaggedError<SavedLayoutNameTakenError>()(
  "SavedLayoutNameTakenError",
  { name: Schema.String },
) {}

/** The person already keeps as many layouts as Mend holds per person. */
export class SavedLayoutLimitError extends Schema.TaggedError<SavedLayoutLimitError>()(
  "SavedLayoutLimitError",
  { limit: Schema.Int },
) {}

/** No layout of the person's has this id. */
export class SavedLayoutNotFoundError extends Schema.TaggedError<SavedLayoutNotFoundError>()(
  "SavedLayoutNotFoundError",
  { id: Schema.String },
) {}

/**
 * Each person's saved layouts (ADR 0026, "Layouts"): the account's own, in every workspace of
 * every organization. Names and layouts arrive checked (`SavedLayoutName`, `TileLayout`); this
 * owns what only the store can check: a name used once per person ignoring case, and the limit.
 */
export class SavedLayoutsRepo extends Context.Service<
  SavedLayoutsRepo,
  {
    /** The person's layouts, oldest first. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<SavedLayout>>;
    readonly save: (
      userId: string,
      input: { readonly name: string; readonly layout: TileLayout },
    ) => Effect.Effect<SavedLayout, SavedLayoutNameTakenError | SavedLayoutLimitError>;
    /** Changes only the name. */
    readonly rename: (
      userId: string,
      id: string,
      name: string,
    ) => Effect.Effect<SavedLayout, SavedLayoutNameTakenError | SavedLayoutNotFoundError>;
    /** Whether the person had a layout with this id to remove. */
    readonly remove: (userId: string, id: string) => Effect.Effect<boolean>;
  }
>()("@mend/db/SavedLayoutsRepo") {}

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete" | "execute">;
type Row = typeof userSavedLayouts.$inferSelect;

const decodeLayout = Schema.decodeUnknownOption(TileLayout);

/**
 * A row as a saved layout, or none when its layout doesn't read: a version a later Mend wrote,
 * read by this one after a downgrade. It stays stored and can still be removed.
 */
const toLayout = (row: Row): Option.Option<SavedLayout> =>
  Option.map(
    decodeLayout(row.layout),
    (layout) =>
      new SavedLayout({
        id: row.id,
        name: row.name,
        layout,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
  );

/** One save or rename at a time per person: the name and limit checks read what they add to. */
const lock = (tx: Tx, userId: string) =>
  tx
    .execute(sql`select pg_advisory_xact_lock(hashtext(${`mend:saved-layouts:${userId}`}))`)
    .pipe(Effect.orDie);

/** Whether another of the person's layouts (not `except`) has this name, ignoring case. */
const nameTaken = (tx: Tx, userId: string, name: string, except?: string) =>
  tx
    .select({ id: userSavedLayouts.id })
    .from(userSavedLayouts)
    .where(
      and(
        eq(userSavedLayouts.userId, userId),
        sql`lower(${userSavedLayouts.name}) = lower(${name})`,
        except === undefined ? undefined : ne(userSavedLayouts.id, SavedLayoutId.make(except)),
      ),
    )
    .limit(1)
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length > 0),
    );

export const SavedLayoutsRepoLive: Layer.Layer<SavedLayoutsRepo, never, MendDB> = Layer.effect(
  SavedLayoutsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const list = Effect.fn("SavedLayoutsRepo.list")(function* (userId: string) {
      const rows = yield* db
        .select()
        .from(userSavedLayouts)
        .where(eq(userSavedLayouts.userId, userId))
        .orderBy(asc(userSavedLayouts.createdAt), asc(userSavedLayouts.id))
        .pipe(Effect.orDie);
      const layouts = rows.map(toLayout);
      const unread = layouts.filter(Option.isNone).length;
      if (unread > 0) {
        yield* Effect.logWarning("saved layouts this Mend can't read were left out of the list", {
          userId,
          unread,
        });
      }
      return layouts.flatMap((layout) => (Option.isSome(layout) ? [layout.value] : []));
    });

    const save = Effect.fn("SavedLayoutsRepo.save")(function* (
      userId: string,
      input: { readonly name: string; readonly layout: TileLayout },
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lock(tx, userId);
            if (yield* nameTaken(tx, userId, input.name)) {
              return yield* new SavedLayoutNameTakenError({ name: input.name });
            }
            const [counted] = yield* tx
              .select({ count: sql<number>`count(*)::int` })
              .from(userSavedLayouts)
              .where(eq(userSavedLayouts.userId, userId))
              .pipe(Effect.orDie);
            if ((counted?.count ?? 0) >= SAVED_LAYOUT_LIMITS.layouts) {
              return yield* new SavedLayoutLimitError({ limit: SAVED_LAYOUT_LIMITS.layouts });
            }
            const [created] = yield* tx
              .insert(userSavedLayouts)
              .values({
                id: SavedLayoutId.make(crypto.randomUUID()),
                userId,
                name: input.name,
                layout: Schema.encodeSync(TileLayout)(input.layout),
              })
              .returning()
              .pipe(Effect.orDie);
            if (created === undefined)
              return yield* Effect.die("saved layout insert returned no row");
            return new SavedLayout({
              id: created.id,
              name: created.name,
              layout: input.layout,
              createdAt: created.createdAt,
              updatedAt: created.updatedAt,
            });
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const rename = Effect.fn("SavedLayoutsRepo.rename")(function* (
      userId: string,
      id: string,
      name: string,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lock(tx, userId);
            if (yield* nameTaken(tx, userId, name, id)) {
              return yield* new SavedLayoutNameTakenError({ name });
            }
            const [renamed] = yield* tx
              .update(userSavedLayouts)
              .set({ name, updatedAt: yield* DateTime.nowAsDate })
              .where(
                and(
                  eq(userSavedLayouts.userId, userId),
                  eq(userSavedLayouts.id, SavedLayoutId.make(id)),
                ),
              )
              .returning()
              .pipe(Effect.orDie);
            const layout = renamed === undefined ? Option.none() : toLayout(renamed);
            if (Option.isNone(layout)) return yield* new SavedLayoutNotFoundError({ id });
            return layout.value;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const remove = Effect.fn("SavedLayoutsRepo.remove")(function* (userId: string, id: string) {
      const deleted = yield* db
        .delete(userSavedLayouts)
        .where(
          and(eq(userSavedLayouts.userId, userId), eq(userSavedLayouts.id, SavedLayoutId.make(id))),
        )
        .returning({ id: userSavedLayouts.id })
        .pipe(Effect.orDie);
      return deleted.length > 0;
    });

    return { list, save, rename, remove };
  }),
);
