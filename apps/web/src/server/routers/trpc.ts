import { initTRPC } from "@trpc/server";
import { Schema } from "effect";
import superjson from "superjson";

import { ApiRefusal } from "../api/errors.ts";
import type { TrpcContext } from "../api/index.ts";

/**
 * tRPC init for the web tier. superjson carries the contract's Type side to
 * the browser intact — real Dates, bigint sequence counters, branded ids —
 * so the UI works with the same types the domain declares, not a JSON echo.
 */
const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // The refusal's tag rides beside its words for the pages that branch on it (a worktree that is
  // live, a name taken); the message a person reads never carries it (api/errors.ts).
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: { ...shape.data, tag: error.cause instanceof ApiRefusal ? error.cause.tag : null },
  }),
});

export const router = t.router;
export const procedure = t.procedure;

/** Effect Schema speaks Standard Schema v1, which tRPC v11 accepts natively. */
export const input = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardSchemaV1(schema);
