import type { KeptReviews, SharedRecord } from "./review/kept-reviews.js";
import { mergeLastSeen, type LastSeen } from "./session-model.js";

export interface LastSeenStore {
  read(url: string): Promise<LastSeen | null>;
  merge(url: string, mine: LastSeen, forget: ReadonlyArray<string>): Promise<LastSeen>;
}

export const parseLastSeen = (value: unknown): LastSeen | null => {
  if (typeof value !== "object" || value === null) return null;
  const baseline: unknown = Reflect.get(value, "baseline");
  const sessions: unknown = Reflect.get(value, "sessions");
  if (typeof baseline !== "string" || typeof sessions !== "object" || sessions === null)
    return null;
  const looks = Object.entries(sessions).flatMap(([id, at]) =>
    typeof at === "string" ? [[id, at]] : [],
  );
  return { baseline, sessions: Object.fromEntries(looks) };
};

const recordOf = (url: string): SharedRecord<LastSeen | null> => ({
  name: `last-seen/${encodeURIComponent(url)}.json`,
  what: "what this VS Code last looked at",
  format: 1,
  onUnreadable: "overwrite",
  parse: parseLastSeen,
});

export class LastSeenFile implements LastSeenStore {
  constructor(private readonly kept: Pick<KeptReviews, "readRecord" | "updateRecord">) {}

  read(url: string): Promise<LastSeen | null> {
    return this.kept.readRecord(recordOf(url));
  }

  async merge(url: string, mine: LastSeen, forget: ReadonlyArray<string>): Promise<LastSeen> {
    const kept = await this.kept.updateRecord(recordOf(url), (stored) => {
      const merged = stored === null ? mine : mergeLastSeen(stored, mine);
      if (forget.length === 0) return merged;
      const gone = new Set(forget);
      return {
        ...merged,
        sessions: Object.fromEntries(
          Object.entries(merged.sessions).filter(([id]) => !gone.has(id)),
        ),
      };
    });
    return kept ?? mine;
  }
}
