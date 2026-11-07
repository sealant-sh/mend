import { createHash } from "node:crypto";

import type { McpAppRef } from "@mend/domain/workbench";
import {
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@mend/t3-contracts";
import {
  readMcpAppCsp,
  readMcpAppPermissions,
  type McpAppReference,
} from "@mend/t3-contracts/mcp-app";
import { mcpAppFromToolItem } from "@mend/t3-contracts/tool-output";
import { DateTime, Predicate } from "effect";

import type { ThreadSource } from "./shell.ts";

/** Stable across gateway restarts; it carries neither HTML nor a filesystem path. */
export const mcpAppAttachmentId = (itemId: string): string =>
  `mcp-app:${createHash("sha256").update(itemId).digest("hex")}`;
/** Recognizes only the gateway's opaque app attachment IDs. */
export const isMcpAppAttachmentId = (id: string): boolean => /^mcp-app:[a-f0-9]{64}$/.test(id);

const reference = (app: McpAppRef): McpAppReference => {
  const csp = readMcpAppCsp(app.csp);
  const permissions = readMcpAppPermissions(app.permissions);
  return {
    attachmentId: mcpAppAttachmentId(app.itemId),
    server: app.server,
    tool: app.tool,
    resourceUri: app.resourceUri,
    ...(csp === undefined ? {} : { csp }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(app.prefersBorder === undefined ? {} : { prefersBorder: app.prefersBorder }),
  };
};

/** Only Mend's captured reference makes a frame; provider output cannot forge one. */
export const withMcpApp = (
  item: OrchestrationV2TurnItem,
  app: McpAppRef | undefined,
  result: unknown,
): OrchestrationV2TurnItem =>
  app === undefined
    ? item
    : {
        ...item,
        type: "dynamic_tool",
        toolName: `${app.server}.${app.tool}`,
        providerThreadId: item.providerThreadId ?? null,
        providerTurnId: item.providerTurnId ?? null,
        input: item.type === "dynamic_tool" ? item.input : {},
        output: {
          t3McpApp: reference(app),
          result: Predicate.isObject(result) && "result" in result ? result.result : result,
        },
      };

/** Extend retained fork evidence here rather than changing the fork lane's projection. */
export const inheritedMcpAppsOf = (
  source: ThreadSource,
  inherited: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> => {
  const rows = [...inherited];
  const order = new Map<string, number>();
  let ordinal = 0;
  for (const turn of source.nativeHistory?.fork?.history ?? []) {
    order.set(`input:${turn.sourceTurnId}`, ordinal++);
    for (const item of turn.items) {
      order.set(item.id, ordinal++);
      const app = source.mcpAppRefs?.get(item.id);
      if (app === undefined) continue;
      const index = rows.findIndex((row) => row.sourceItemId === item.id);
      const existing = index === -1 ? undefined : rows[index];
      const threadId = ThreadId.make(app.sessionId);
      const at = DateTime.makeUnsafe(turn.createdAt.toISOString());
      const end = DateTime.makeUnsafe((turn.endedAt ?? turn.createdAt).toISOString());
      const base: OrchestrationV2TurnItem = existing?.item ?? {
        id: TurnItemId.make(`inherited:${turn.sourceSessionId}:${turn.sourceTurnId}:${item.id}`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: "Inherited conversation evidence",
        startedAt: at,
        completedAt: end,
        updatedAt: end,
        type: "dynamic_tool",
        toolName: `${app.server}.${app.tool}`,
        input: {},
      };
      const row: OrchestrationV2ProjectedTurnItem = {
        position: 0,
        visibility: "inherited",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make(item.id),
        item: withMcpApp(base, app, item.text),
      };
      if (index === -1) rows.push(row);
      else rows[index] = row;
    }
  }
  return rows
    .toSorted((a, b) => (order.get(a.sourceItemId) ?? 0) - (order.get(b.sourceItemId) ?? 0))
    .map((row, position) => ({ ...row, position, item: { ...row.item, ordinal: position } }));
};

/** Inherited frames need a snapshot reset; local item events cannot carry their provenance. */
export const inheritedMcpAppRevision = (
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): string => {
  const apps = rows.flatMap((row) => {
    if (row.visibility !== "inherited" || row.item.type !== "dynamic_tool") return [];
    const app = mcpAppFromToolItem(row.item);
    return app === undefined ? [] : [[row.sourceThreadId, row.sourceItemId, app]];
  });
  return createHash("sha256").update(JSON.stringify(apps)).digest("hex");
};
