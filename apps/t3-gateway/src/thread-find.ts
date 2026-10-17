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

const leastRecentlyUsed = <A>(capacity: number) => {
  const entries = new Map<string, A>();
  return (key: string, compute: () => A): A => {
    const cached = entries.get(key);
    entries.delete(key);
    const value = cached ?? compute();
    entries.set(key, value);
    const oldest = entries.keys().next();
    if (entries.size > capacity && oldest.done !== true) entries.delete(oldest.value);
    return value;
  };
};

const LARGE_TEXT = 32_768;
const shortTextSegments = leastRecentlyUsed<ReadonlyArray<string>>(512);
const longTextSegments = leastRecentlyUsed<ReadonlyArray<string>>(32);

const segmentsOf = (
  item: OrchestrationV2TurnItem,
  cwd: string | undefined,
  skills: Skills,
): ReadonlyArray<string> => {
  const searchable = searchableTextOf(item);
  const remembered = searchable.text.length <= LARGE_TEXT ? shortTextSegments : longTextSegments;
  const key = JSON.stringify([
    searchable.role,
    searchable.streaming,
    searchable.hasContext,
    cwd ?? null,
    skills,
    searchable.text,
  ]);
  return remembered(key, () => parseSegments(searchable, cwd, skills));
};

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

const documentOf = (
  { item }: OrchestrationV2ProjectedTurnItem,
  query: string,
  cwd: string | undefined,
  skills: Skills,
): FindDocument => ({
  entryId: entryIdOf(item),
  runId: item.runId,
  count: segmentsOf(item, cwd, skills).reduce(
    (sum, text) => sum + countThreadSearchOccurrences(text, query),
    0,
  ),
});

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

const worktreeOf = ({ projection }: ThreadSnapshot) => projection.thread.worktreePath ?? undefined;

export const findInThread = (
  snapshot: ThreadSnapshot,
  search: OrchestrationV2SearchThreadInput,
): OrchestrationV2SearchThreadResult => {
  const skills = search.skills ?? [];
  const cwd = worktreeOf(snapshot);
  const documents = searchableRows(snapshot.projection.visibleTurnItems).map((row) =>
    documentOf(row, search.query, cwd, skills),
  );
  return resultOf(selectMatch(documents, search), documents, snapshot.snapshotSequence);
};

const stepsFromSelection = (search: OrchestrationV2SearchThreadInput) =>
  search.index !== undefined || (search.offset ?? 0) !== 0;

export const firstMatchInThread = (
  snapshot: ThreadSnapshot,
  search: OrchestrationV2SearchThreadInput,
): OrchestrationV2SearchThreadResult | null => {
  if (stepsFromSelection(search)) return null;
  const skills = search.skills ?? [];
  const cwd = worktreeOf(snapshot);
  const rows = searchableRows(snapshot.projection.visibleTurnItems);
  const anchor = Math.max(
    0,
    rows.findIndex(({ item }) => entryIdOf(item) === search.start?.entryId),
  );
  for (let step = 0; step <= rows.length; step++) {
    const row = rows[(anchor + step) % rows.length];
    if (row === undefined) break;
    const document = documentOf(row, search.query, cwd, skills);
    const occurrence =
      step === 0 && document.entryId === search.start?.entryId
        ? Math.min(search.start.occurrence, document.count)
        : 0;
    if (occurrence >= document.count) continue;
    return {
      complete: false,
      snapshotSequence: snapshot.snapshotSequence,
      totalMatches: 1,
      activeIndex: 0,
      match: { entryId: document.entryId, runId: document.runId, occurrence },
    };
  }
  return null;
};
