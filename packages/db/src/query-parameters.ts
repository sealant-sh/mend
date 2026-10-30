import { is } from "drizzle-orm";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { Cause } from "effect";

/**
 * `Cause.pretty` for a log, with each failed query's parameters withheld: they are what a person
 * wrote (a turn's input, a steer's words). A failed query keeps its statement, its stack and the
 * database's error beneath it. It is found as a failure or a defect, as an Error's cause, or in a
 * cause beneath any of those; one held by any other value is rendered as it was.
 */
export const prettyCause = <E>(cause: Cause.Cause<E>): string =>
  Cause.pretty(withoutQueryParameters(cause));

const withoutQueryParameters = <E>(cause: Cause.Cause<E>): Cause.Cause<unknown> =>
  Cause.fromReasons(
    cause.reasons.map((reason): Cause.Reason<unknown> => {
      if (Cause.isDieReason(reason)) {
        return Cause.makeDieReason(withheld(reason.defect)).annotate(
          Cause.reasonAnnotations(reason),
        );
      }
      if (Cause.isFailReason(reason)) {
        return Cause.makeFailReason(withheld(reason.error)).annotate(
          Cause.reasonAnnotations(reason),
        );
      }
      return reason;
    }),
  );

const withheld = (value: unknown): unknown => {
  if (is(value, EffectDrizzleQueryError)) {
    const header = `${value.name}: ${value.message}`;
    const frames = value.stack?.startsWith(header) ? value.stack.slice(header.length) : "";
    const query = new Error(
      `Failed query: ${value.query}\nparams: ${value.params.length} withheld`,
      { cause: withheld(value.cause) },
    );
    query.name = value.name;
    query.stack = `${query.name}: ${query.message}${frames}`;
    return query;
  }
  if (Cause.isCause(value)) return withoutQueryParameters(value);
  if (value instanceof Error && value.cause !== undefined) {
    const below = withheld(value.cause);
    if (below === value.cause) return value;
    const copy = new Error(value.message, { cause: below });
    copy.name = value.name;
    if (value.stack !== undefined) copy.stack = value.stack;
    return copy;
  }
  return value;
};
