import { RemovalBlocker } from "@mend/domain/workbench";
import { TRPCClientError } from "@trpc/client";
import { Option, Schema } from "effect";

import { refusalTagOf } from "./refusal.ts";

/** A refused removal as the web tier passes it beside the words (`data.removal`). */
export const RemovalRefusal = Schema.Struct({
  scope: Schema.Literals(["worktree", "project"]),
  blockers: Schema.NonEmptyArray(RemovalBlocker),
  forceWouldLift: Schema.Boolean,
});
export type RemovalRefusal = typeof RemovalRefusal.Type;

const decodeRemoval = Schema.decodeUnknownOption(RemovalRefusal);

/** The blockers of a refused removal, or null for any other failure. */
export const removalRefusalDataOf = (cause: unknown): RemovalRefusal | null => {
  if (refusalTagOf(cause) !== "RemovalRefused" || !(cause instanceof TRPCClientError)) return null;
  const data: unknown = cause.data;
  if (typeof data !== "object" || data === null || !("removal" in data)) return null;
  return Option.getOrNull(decodeRemoval(data.removal));
};
