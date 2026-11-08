import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  UsageReadError,
  type ThreadTokenUsageSnapshot,
  type UsageBucket,
  type UsageSummary,
  type UsageSummaryInput,
} from "@mend/t3-contracts";

import type { MendTurn } from "./mend-workbench.ts";
import type { ThreadSource } from "./shell.ts";

/** Token counts for one completed turn, attributed only when Mend recorded its payer. */
export interface RecordedUsage {
  readonly sessionId: string;
  readonly billedUserId: string | null;
  readonly provider: "codex" | "claude";
  readonly model: string;
  readonly at: string;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

const count = (value: number | null | undefined): number | null =>
  value != null && Number.isSafeInteger(value) && value >= 0 ? value : null;

const validDay = (day: string): boolean =>
  !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;

/** Only a recorded last-call context count can drive the meter; historical totals cannot. */
export const completedContextOf = (
  turns: ReadonlyArray<MendTurn>,
): ThreadTokenUsageSnapshot | null => {
  const turn = turns
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .findLast((candidate) => candidate.usage != null);
  const usage = turn?.usage;
  const usedTokens = count(usage?.contextTokens);
  if (usage == null || usedTokens === null) return null;
  const totalProcessedTokens = count(usage.totalTokens);
  const maxTokens = count(usage.contextWindow);
  return {
    usedTokens,
    ...(totalProcessedTokens === null ? {} : { totalProcessedTokens }),
    ...(maxTokens === null || maxTokens === 0 ? {} : { maxTokens }),
  };
};

/** Codex reports cumulative counters; Claude reports each turn. Never sum Codex totals twice. */
export const recordedUsageOf = (source: ThreadSource): ReadonlyArray<RecordedUsage> => {
  const provider =
    source.session.harness === "codex"
      ? "codex"
      : source.session.harness === "claude"
        ? "claude"
        : null;
  if (provider === null) return [];
  const records: Array<RecordedUsage> = [];
  let previous: { input: number; cached: number; output: number; ordinal: number } | null = null;
  for (const turn of source.turns.toSorted((a, b) => a.ordinal - b.ordinal)) {
    const input = count(turn.usage?.inputTokens);
    const output = count(turn.usage?.outputTokens);
    if (input === null || output === null || turn.endedAt === null) continue;
    const current = {
      input,
      cached: count(turn.usage?.cachedInputTokens) ?? 0,
      output,
      ordinal: turn.ordinal,
    };
    // A fork's first counter can include its parent's work. A missing counter or reset
    // also loses the boundary between payers. Keep that counter as a baseline only.
    const baseline =
      provider === "claude" ||
      (turn.ordinal === 0 && source.nativeHistory != null && source.nativeHistory.fork === null)
        ? { input: 0, cached: 0, output: 0 }
        : previous !== null &&
            previous.ordinal === turn.ordinal - 1 &&
            current.input >= previous.input &&
            current.output >= previous.output &&
            current.cached >= previous.cached
          ? previous
          : null;
    previous = current;
    if (baseline === null) continue;
    const recorded = {
      input: current.input - baseline.input,
      cached: current.cached - baseline.cached,
      output: current.output - baseline.output,
    };
    if (recorded.input + recorded.cached + recorded.output === 0) continue;
    records.push({
      ...recorded,
      sessionId: source.session.id,
      billedUserId: turn.billedUserId ?? null,
      provider,
      model: turn.selection?.model ?? "unknown",
      at: turn.endedAt,
    });
  }
  return records;
};

/** Summarize recorded usage in the requested zone. Missing prices remain explicitly unpriced. */
export const usageSummaryOf = (
  records: ReadonlyArray<RecordedUsage>,
  userId: string,
  input: UsageSummaryInput,
  readAt: string,
  hostId: string,
): UsageSummary | UsageReadError => {
  let clock: Intl.DateTimeFormat;
  try {
    clock = new Intl.DateTimeFormat("en-CA", {
      timeZone: input.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return new UsageReadError({ reason: "invalidWindow", detail: "Choose a valid time zone." });
  }
  const since = input.sinceTime === undefined ? null : Date.parse(input.sinceTime);
  const until = input.untilTime === undefined ? null : Date.parse(input.untilTime);
  if (
    !validDay(input.sinceDay) ||
    !validDay(input.untilDay) ||
    input.sinceDay > input.untilDay ||
    (since !== null && !Number.isFinite(since)) ||
    (until !== null && !Number.isFinite(until)) ||
    (since !== null && until !== null && since >= until)
  ) {
    return new UsageReadError({
      reason: "invalidWindow",
      detail: "Choose a valid usage date range.",
    });
  }
  const buckets = new Map<string, UsageBucket>();
  const sessions = new Map<string, Set<string>>();
  const providerSessions = new Map<RecordedUsage["provider"], Set<string>>();
  for (const record of records) {
    if (record.billedUserId !== userId) continue;
    const timestamp = Date.parse(record.at);
    if (
      !Number.isFinite(timestamp) ||
      (since !== null && timestamp < since) ||
      (until !== null && timestamp >= until)
    )
      continue;
    const parts = Object.fromEntries(
      clock.formatToParts(timestamp).map((part) => [part.type, part.value]),
    );
    const day = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
    if (day < input.sinceDay || day > input.untilDay) continue;
    const hourStart =
      input.resolution === "hour"
        ? new Date(
            timestamp -
              Number(parts["minute"]) * 60_000 -
              Number(parts["second"]) * 1000 -
              (timestamp % 1000),
          ).toISOString()
        : undefined;
    const key = JSON.stringify([day, hourStart, record.provider, record.model]);
    const known = sessions.get(key) ?? new Set<string>();
    known.add(record.sessionId);
    sessions.set(key, known);
    const distinct = providerSessions.get(record.provider) ?? new Set<string>();
    distinct.add(record.sessionId);
    providerSessions.set(record.provider, distinct);
    const previous = buckets.get(key);
    const cached =
      record.provider === "codex" ? Math.min(record.input, record.cached) : record.cached;
    // Claude's input counter excludes its cache reads and writes. Mend's historical
    // usage combines both cache categories, so expose that limitation on the source.
    const uncached = record.provider === "codex" ? record.input - cached : record.input;
    buckets.set(key, {
      day: UsageDay.make(day),
      ...(hourStart === undefined ? {} : { hourStart }),
      provider: record.provider,
      model: record.model,
      totals: {
        uncachedInputTokens: (previous?.totals.uncachedInputTokens ?? 0) + uncached,
        cachedInputTokens: (previous?.totals.cachedInputTokens ?? 0) + cached,
        cacheCreationTokens: 0,
        outputTokens: (previous?.totals.outputTokens ?? 0) + record.output,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: (previous?.records ?? 0) + 1,
      unpricedRecords: (previous?.unpricedRecords ?? 0) + 1,
      sessions: known.size,
    });
  }
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt,
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    buckets: [...buckets.values()].toSorted((a, b) =>
      JSON.stringify([a.day, a.hourStart, a.provider, a.model]).localeCompare(
        JSON.stringify([b.day, b.hourStart, b.provider, b.model]),
      ),
    ),
    sources: [...providerSessions].map(([provider, distinct]) => ({
      fingerprint: {
        hostId,
        provider,
        resolvedHomePath: `mend:recorded-usage:${userId}`,
        volumeId: hostId,
      },
      status: "partial",
      scannedFiles: 0,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: distinct.size,
      message:
        "Recorded Mend turns only. Prices and unrecorded usage are unavailable; Claude cache reads and writes are combined.",
    })),
    pricing: {
      status: "unavailable",
      source: "Mend recorded usage",
      fetchedAt: null,
      knownModels: 0,
    },
    scanDurationMs: 0,
  };
};
