/**
 * Postgres unique_violation: a unique key collided with a live row. The driver error sits below
 * the Drizzle error as an Effect `Cause` whose `reasons` carry the SQL error, whose `cause` is
 * pg's, so walk causes and reasons alike until a `code` appears.
 */
export const isUniqueViolation = (error: unknown, depth = 0): boolean =>
  uniqueViolationOf(error, depth) !== null;

/**
 * The unique key the violation names (pg: `constraint`; postgres.js: `constraint_name`), or null
 * when the error is no unique violation. A violation whose driver error carries no name answers
 * the empty string: a violation, of an unknown key.
 */
export const uniqueViolationConstraint = (error: unknown): string | null =>
  uniqueViolationOf(error, 0);

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const uniqueViolationOf = (error: unknown, depth: number): string | null => {
  const found = driverErrorOf(error, UNIQUE_VIOLATION, depth);
  if (found === null) return null;
  return "constraint" in found && typeof found.constraint === "string"
    ? found.constraint
    : "constraint_name" in found && typeof found.constraint_name === "string"
      ? found.constraint_name
      : "";
};

export const isForeignKeyViolation = (error: unknown): boolean =>
  driverErrorOf(error, FOREIGN_KEY_VIOLATION, 0) !== null;

const driverErrorOf = (error: unknown, code: string, depth: number): object | null => {
  if (typeof error !== "object" || error === null || depth > 8) return null;
  if ("code" in error && error.code === code) return error;
  if ("reasons" in error && Array.isArray(error.reasons)) {
    for (const reason of error.reasons) {
      const found = driverErrorOf(reason, code, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if ("cause" in error) {
    const found = driverErrorOf(error.cause, code, depth + 1);
    if (found !== null) return found;
  }
  if ("error" in error) {
    const found = driverErrorOf(error.error, code, depth + 1);
    if (found !== null) return found;
  }
  return "defect" in error ? driverErrorOf(error.defect, code, depth + 1) : null;
};
