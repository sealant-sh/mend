/** A plain object read off JSON or storage, to be checked field by field. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
