import { Schema } from "effect";

import { assert } from "./effect-vitest.ts";

const ReceiptFields = Schema.Struct({
  clientMessageId: Schema.String.check(Schema.isUUID()),
  historyPosition: Schema.Struct({ historyRevision: Schema.Number, worktreeEpoch: Schema.Number }),
  queue: Schema.Literal(true),
});
/** Checks the new queue envelope while existing assertions still check exact words and selection. */
export const keyedMessageFields = (body: unknown) => {
  const fields = Schema.decodeUnknownSync(ReceiptFields)(body);
  assert.deepEqual(fields.historyPosition, { historyRevision: 0, worktreeEpoch: 0 });
  return fields;
};
