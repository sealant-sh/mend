import { createHash } from "node:crypto";

import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2TurnItem,
} from "@mend/t3-contracts";
// t3code's client highlights matches through `threadFindText.ts` and `threadSearch.ts`; counts
// read any other way drift from what it highlights.
import {
  searchableMessageSegments,
  searchablePlanSegments,
} from "@mend/t3-contracts/thread-find-text";
import { countThreadSearchOccurrences } from "@mend/t3-contracts/thread-search";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ThreadSnapshot } from "./hub.ts";

type Skills = NonNullable<OrchestrationV2SearchThreadInput["skills"]>;

interface FindDocument {
  readonly entryId: string;
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly count: number;
}

interface Selection {
  readonly totalMatches: number;
  readonly activeIndex: number;
  readonly document: FindDocument | null;
  readonly occurrence: number;
}

type SearchableText = {
  readonly role: "user" | "assistant" | "plan";
  readonly text: string;
  readonly streaming: boolean;
  readonly hasContext: boolean;
};

const searchableTextOf = (item: OrchestrationV2TurnItem): SearchableText => {
  switch (item.type) {
    case "proposed_plan":
      return { role: "plan", text: item.markdown, streaming: false, hasContext: false };
    case "user_message":
      return {
        role: "user",
        text: item.text,
        streaming: false,
        hasContext: item.context !== undefined,
      };
    case "assistant_message":
      return { role: "assistant", text: item.text, streaming: item.streaming, hasContext: false };
    default:
      return { role: "assistant", text: "", streaming: false, hasContext: false };
  }
};

const parseSegments = (
  { role, text, streaming, hasContext }: SearchableText,
  cwd: string | undefined,
  skills: Skills,
): ReadonlyArray<string> =>
  role === "plan"
    ? searchablePlanSegments(text, cwd)
    : (searchableMessageSegments(
        {
          role,
          text,
          streaming,
          context: hasContext ? { version: 1, records: [] } : undefined,
        },
        cwd,
        skills,
      ) ?? []);

export interface CacheLimits {
  readonly entries: number;
  readonly bytes: number;
}

export interface FindCacheLimits {
  readonly parses: CacheLimits;
  readonly scans: CacheLimits;
}

export const FIND_CACHE_LIMITS: FindCacheLimits = {
  parses: { entries: 512, bytes: 16 * 1024 * 1024 },
  scans: { entries: 8, bytes: 2 * 1024 * 1024 },
};

const V8_STRING_HEADER_BYTES = 32;
const UTF16_BYTES_PER_CHARACTER = 2;
const SHA256_HEX_LENGTH = 64;
const MAP_ENTRY_BYTES = 64;
const DOCUMENT_BYTES = 48;
const stringBytes = (length: number) => V8_STRING_HEADER_BYTES + UTF16_BYTES_PER_CHARACTER * length;
const KEY_BYTES = stringBytes(SHA256_HEX_LENGTH) + MAP_ENTRY_BYTES;

const leastRecentlyUsed = <A>(limits: CacheLimits, bytesOf: (value: A) => number) => {
  const entries = new Map<string, { readonly value: A; readonly bytes: number }>();
  let held = 0;
  return {
    get: (key: string): A | undefined => {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set: (key: string, value: A): void => {
      const previous = entries.get(key);
      if (previous !== undefined) {
        entries.delete(key);
        held -= previous.bytes;
      }
      const bytes = KEY_BYTES + bytesOf(value);
      if (bytes > limits.bytes) return;
      entries.set(key, { value, bytes });
      held += bytes;
      for (const [oldest, entry] of entries) {
        if (entries.size <= limits.entries && held <= limits.bytes) break;
        entries.delete(oldest);
        held -= entry.bytes;
      }
    },
    bytes: () => held,
  };
};

const lengthPrefixedDigest = (parts: Iterable<string>): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:`).update(part);
  return hash.digest("hex");
};

interface Parse {
  readonly segments: ReadonlyArray<string>;
  /** The message's length: a segment may be a slice that keeps the whole message alive. */
  readonly sourceLength: number;
}

const parseBytes = ({ segments, sourceLength }: Parse) =>
  segments.reduce((sum, segment) => sum + stringBytes(segment.length), stringBytes(sourceLength));

const scanBytes = (documents: ReadonlyArray<FindDocument>) =>
  documents.reduce(
    (sum, { entryId, runId }) =>
      sum + DOCUMENT_BYTES + stringBytes(entryId.length + (runId?.length ?? 0)),
    0,
  );

const SEARCHABLE_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "user_message",
  "assistant_message",
  "proposed_plan",
]);

const questionCardAnswerMessageId = (requestId: string) => `async-answer:${requestId}`;

const searchableRows = (items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) => {
  const answersInQuestionCards = new Set(
    items.flatMap(({ item }) =>
      item.type === "user_input_request" && item.questionAnswer
        ? [questionCardAnswerMessageId(item.questionAnswer.requestId)]
        : [],
    ),
  );
  return items.filter(
    ({ item }) =>
      SEARCHABLE_TYPES.has(item.type) &&
      !(item.type === "user_message" && answersInQuestionCards.has(item.messageId)),
  );
};

const entryIdOf = (item: OrchestrationV2TurnItem) =>
  item.type === "user_message" || item.type === "assistant_message" ? item.messageId : item.id;

const selectMatch = (
  documents: ReadonlyArray<FindDocument>,
  input: Pick<OrchestrationV2SearchThreadInput, "index" | "start" | "offset">,
): Selection => {
  const totalMatches = documents.reduce((sum, doc) => sum + doc.count, 0);
  let requestedIndex = input.index ?? 0;
  if (input.index === undefined && input.start) {
    const { entryId, occurrence } = input.start;
    const startIndex = documents.findIndex((doc) => doc.entryId === entryId);
    const started = documents[startIndex];
    if (started !== undefined) {
      requestedIndex =
        documents.slice(0, startIndex).reduce((sum, doc) => sum + doc.count, 0) +
        Math.min(occurrence, started.count);
      if (requestedIndex >= totalMatches) requestedIndex = 0;
    }
  }
  const activeIndex =
    input.index === undefined && totalMatches > 0
      ? (((requestedIndex + (input.offset ?? 0)) % totalMatches) + totalMatches) % totalMatches
      : Math.min(requestedIndex, Math.max(0, totalMatches - 1));
  let occurrence = activeIndex;
  for (const document of documents) {
    if (occurrence < document.count) return { totalMatches, activeIndex, document, occurrence };
    occurrence -= document.count;
  }
  return { totalMatches, activeIndex, document: null, occurrence: 0 };
};

const ENTRIES_CLIENT_STEPS_WITHOUT_ASKING = 17;

const resultOf = (
  selected: Selection,
  documents: ReadonlyArray<FindDocument>,
  snapshotSequence: number,
): OrchestrationV2SearchThreadResult => {
  let startIndex = 0;
  const entries = documents.flatMap(({ entryId, runId, count }) => {
    const entry = { entryId, runId, count, startIndex };
    startIndex += count;
    return count > 0 ? [entry] : [];
  });
  const selectedEntry = entries.findIndex((entry) => entry.entryId === selected.document?.entryId);
  const navigation =
    entries.length <= ENTRIES_CLIENT_STEPS_WITHOUT_ASKING
      ? entries
      : Array.from(
          { length: ENTRIES_CLIENT_STEPS_WITHOUT_ASKING },
          (_, i) =>
            entries[
              (selectedEntry + i - (ENTRIES_CLIENT_STEPS_WITHOUT_ASKING - 1) / 2 + entries.length) %
                entries.length
            ],
        ).filter((entry) => entry !== undefined);
  return {
    snapshotSequence,
    totalMatches: selected.totalMatches,
    activeIndex: selected.activeIndex,
    navigation,
    match:
      selected.document === null
        ? null
        : {
            entryId: selected.document.entryId,
            runId: selected.document.runId,
            occurrence: selected.occurrence,
          },
  };
};

const stepsFromSelection = (search: OrchestrationV2SearchThreadInput) =>
  search.index !== undefined || (search.offset ?? 0) !== 0;

interface FindRow {
  readonly entryId: string;
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly searchable: SearchableText;
  readonly parseKey: string;
}

export interface ThreadFinder {
  /**
   * `orchestration.searchThreadStream`: the match at the reading position first (`complete:
   * false`), then the thread's count. A query asked again of an unchanged thread answers with the
   * count alone, as t3code's does.
   */
  readonly searchThreadStream: (
    snapshot: ThreadSnapshot,
    search: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult>;
  readonly searchThread: (
    snapshot: ThreadSnapshot,
    search: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult>;
  readonly retainedBytes: () => number;
}

export const makeThreadFinder = (limits: FindCacheLimits = FIND_CACHE_LIMITS): ThreadFinder => {
  const parses = leastRecentlyUsed<Parse>(limits.parses, parseBytes);
  const scans = leastRecentlyUsed<ReadonlyArray<FindDocument>>(limits.scans, scanBytes);

  const scanOf = (snapshot: ThreadSnapshot, search: OrchestrationV2SearchThreadInput) =>
    Effect.gen(function* () {
      const skills = search.skills ?? [];
      const cwd = snapshot.projection.thread.worktreePath ?? undefined;
      const context = lengthPrefixedDigest([JSON.stringify([cwd ?? null, skills])]);
      const rows: Array<FindRow> = [];
      for (const { item } of searchableRows(snapshot.projection.visibleTurnItems)) {
        const searchable = searchableTextOf(item);
        const { role, streaming, hasContext, text } = searchable;
        rows.push({
          entryId: entryIdOf(item),
          runId: item.runId,
          searchable,
          parseKey: lengthPrefixedDigest([
            context,
            role,
            String(streaming),
            String(hasContext),
            text,
          ]),
        });
        yield* Effect.yieldNow;
      }
      const scanKey = lengthPrefixedDigest([
        search.query,
        ...rows.flatMap(({ entryId, runId, parseKey }) => [entryId, runId ?? "", parseKey]),
      ]);
      const answer = (documents: ReadonlyArray<FindDocument>) =>
        resultOf(selectMatch(documents, search), documents, snapshot.snapshotSequence);
      const scanned = scans.get(scanKey);
      if (scanned !== undefined) return { kind: "answered" as const, result: answer(scanned) };

      const counted = new Map<number, FindDocument>();
      const count = Effect.fnUntraced(function* (index: number, row: FindRow) {
        const known = counted.get(index);
        if (known !== undefined) return known;
        let parse = parses.get(row.parseKey);
        if (parse === undefined) {
          parse = {
            segments: parseSegments(row.searchable, cwd, skills),
            sourceLength: row.searchable.text.length,
          };
          parses.set(row.parseKey, parse);
        }
        const document: FindDocument = {
          entryId: row.entryId,
          runId: row.runId,
          count: parse.segments.reduce(
            (sum, text) => sum + countThreadSearchOccurrences(text, search.query),
            0,
          ),
        };
        counted.set(index, document);
        yield* Effect.yieldNow;
        return document;
      });
      const counts = Effect.gen(function* () {
        const documents: Array<FindDocument> = [];
        for (const [index, row] of rows.entries()) documents.push(yield* count(index, row));
        scans.set(scanKey, documents);
        return answer(documents);
      });
      return { kind: "counting" as const, rows, count, counts };
    });

  return {
    searchThreadStream: (snapshot, search) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const scan = yield* scanOf(snapshot, search);
          if (scan.kind === "answered") return Stream.succeed(scan.result);
          const { rows, count, counts } = scan;
          if (stepsFromSelection(search)) return Stream.fromEffect(counts);
          const anchor = Math.max(
            0,
            rows.findIndex((row) => row.entryId === search.start?.entryId),
          );
          const stepsBackToTheAnchor = rows.length + 1;
          for (let step = 0; step < stepsBackToTheAnchor; step++) {
            const index = (anchor + step) % rows.length;
            const row = rows[index];
            if (row === undefined) break;
            const document = yield* count(index, row);
            const occurrence =
              step === 0 && row.entryId === search.start?.entryId
                ? Math.min(search.start.occurrence, document.count)
                : 0;
            if (occurrence >= document.count) continue;
            const first: OrchestrationV2SearchThreadResult = {
              complete: false,
              snapshotSequence: snapshot.snapshotSequence,
              totalMatches: 1,
              activeIndex: 0,
              match: { entryId: document.entryId, runId: document.runId, occurrence },
            };
            return Stream.concat(Stream.succeed(first), Stream.fromEffect(counts));
          }
          return Stream.fromEffect(counts);
        }),
      ),
    searchThread: (snapshot, search) =>
      scanOf(snapshot, search).pipe(
        Effect.flatMap((scan) =>
          scan.kind === "answered" ? Effect.succeed(scan.result) : scan.counts,
        ),
      ),
    retainedBytes: () => parses.bytes() + scans.bytes(),
  };
};
