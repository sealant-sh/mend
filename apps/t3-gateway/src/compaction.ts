import { ProviderDriverKind, type OrchestrationV2TurnItem } from "@mend/t3-contracts";

import type { MendItem } from "./mend-workbench.ts";

type Compaction = Extract<OrchestrationV2TurnItem, { type: "compaction" }>;

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Native compaction metadata, kept separate from ordinary tools and assistant messages. */
export const compactionOf = (
  item: MendItem,
): Pick<
  Compaction,
  "type" | "driver" | "title" | "beforeTokenCount" | "afterTokenCount"
> | null => {
  const data = item.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const codex = "type" in data && data.type === "contextCompaction";
  const claude = "_tag" in data && data._tag === "ClaudeCompaction";
  if (!codex && !claude) return null;
  const before = "beforeTokenCount" in data ? tokenCount(data.beforeTokenCount) : undefined;
  const after = "afterTokenCount" in data ? tokenCount(data.afterTokenCount) : undefined;
  return {
    type: "compaction",
    driver: ProviderDriverKind.make(codex ? "codex" : "claudeAgent"),
    title:
      item.status === "in-progress"
        ? "Compacting context"
        : item.status === "failed"
          ? "Context compaction failed"
          : item.status === "declined"
            ? "Context compaction stopped"
            : "Context compacted",
    ...(before === undefined ? {} : { beforeTokenCount: before }),
    ...(after === undefined ? {} : { afterTokenCount: after }),
  };
};
