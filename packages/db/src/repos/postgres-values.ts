/** PostgreSQL text/jsonb cannot store NUL. Keep a visible escape instead of losing the byte. */
export const escapePostgresText = (value: string): string => value.replaceAll("\u0000", "\\u0000");

/** Drizzle needs a non-null value to serialize JSON null rather than SQL NULL. */
const jsonNull = Object.freeze({ toJSON: (): null => null });

/** Escape NUL in JSON string values and keys, preserving existing literal escape sequences. */
export const toPostgresJsonb = (value: unknown): unknown => {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string") return escapePostgresText(item);
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).map(([key, field]) => [escapePostgresText(key), field]),
      );
    }
    return item;
  });
  if (encoded === undefined || encoded === "null") return jsonNull;
  const decoded: unknown = JSON.parse(encoded);
  return decoded;
};
