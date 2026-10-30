/* oxlint-disable -- Generated verbatim from t3code v0.1.2; regenerate with sync.mjs. */
/*
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

// upstream:packages/shared/src/Array.ts
function copySorted(values, compareFn) {
  return [...values].sort(compareFn);
}

// upstream:packages/client-runtime/src/state/threadWorkflows.ts
var ACTIVE_RUN_STATUSES = /* @__PURE__ */ new Set(["preparing", "starting", "running", "waiting"]);
function resolveActiveThreadRun(projection) {
  return projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
}
function resolveThreadProviderSession(projection) {
  const activeRun = resolveActiveThreadRun(projection);
  const providerThreadId = activeRun?.providerThreadId ?? projection.thread.activeProviderThreadId;
  const activeProviderThread =
    providerThreadId === null
      ? null
      : (projection.providerThreads.find((thread) => thread.id === providerThreadId) ?? null);
  const attachedProviderThread =
    activeProviderThread ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    ) ??
    null;
  const sessionId = attachedProviderThread?.providerSessionId ?? null;
  if (sessionId !== null) {
    return projection.providerSessions.find((session) => session.id === sessionId) ?? null;
  }
  return (
    projection.providerSessions.findLast(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? null
  );
}
function getUserQueuedThreadRuns(projection) {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter(
        (message) => message.delegatedCompletion !== void 0 || message.notification !== void 0,
      )
      .map((message) => message.id),
  );
  return projection.runs.filter(
    (run) => run.status === "queued" && !automaticCompletionMessageIds.has(run.userMessageId),
  );
}
function deriveThreadQueueWorkflowState(projection) {
  const activeRun = resolveActiveThreadRun(projection);
  const session = resolveThreadProviderSession(projection);
  const capabilities = session?.capabilities.turns;
  const hasSteerableProviderTurn =
    activeRun?.status === "running" &&
    activeRun.activeAttemptId !== null &&
    projection.providerTurns.some(
      (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
    );
  const queuedRuns = copySorted(
    getUserQueuedThreadRuns(projection),
    (left, right) =>
      (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
      left.ordinal - right.ordinal,
  ).map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return {
      run,
      text: message?.text ?? "Queued message",
      attachments: message?.attachments ?? [],
      messageId: run.userMessageId,
      ...(message?.context ? { context: message.context } : {}),
    };
  });
  return {
    activeRun,
    queuedRuns,
    isHeld: projection.runs.some((run) => run.status === "queued" && run.queueHeld === true),
    canReorder: capabilities?.supportsQueuedMessages === true,
    canSendNow:
      activeRun === null &&
      projection.thread.archivedAt == null &&
      projection.thread.deletedAt == null,
    canPromoteToSteer:
      hasSteerableProviderTurn &&
      (capabilities?.supportsActiveSteering === true ||
        capabilities?.supportsSteeringByInterruptRestart === true),
  };
}

// upstream:packages/shared/src/threadPullRequests.ts
import { pullRequestHostOf } from "@mend/t3-contracts";
// upstream:packages/shared/src/sourceControl.ts
import { SourceControlProviderKind } from "@mend/t3-contracts";
function canonicalRepositoryKey(key) {
  return key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
}

// upstream:packages/shared/src/changeRequestUrl.ts
function isHostOf(hostname, apex, label) {
  if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  return label !== void 0 && hostname.split(".").includes(label);
}
function parseChangeRequestUrl(targetUrl) {
  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "git.cafe" || host === "staging.git.cafe") {
    const match = /^\/([^/]+\/[^/]+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (match) return claim(host, match);
  } else {
    if (isHostOf(host, "github.com", "github")) {
      const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u.exec(url.pathname);
      if (match) return claim(host, match);
    }
    const forgejo = /^\/([^/]+(?:\/[^/]+)+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (forgejo) {
      const link2 = claim(host, forgejo);
      return link2 === null ? null : { ...link2, authority: url.host.toLowerCase() };
    }
    const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (gitlab) return claim(host, gitlab);
    if (isHostOf(host, "bitbucket.org", "bitbucket")) {
      const match = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
      if (match) return claim(host, match);
    }
  }
  const azure = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u.exec(url.pathname);
  const link = claim(host, azure);
  return link === null || url.port === "" ? link : { ...link, authority: url.host.toLowerCase() };
}
function claim(host, match) {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

// upstream:packages/shared/src/threadPullRequests.ts
function normalizeThreadPullRequestKey(key) {
  const parsed = key.url === void 0 ? null : parseChangeRequestUrl(key.url);
  const authority =
    key.authority ??
    (parsed?.repository === key.repository.trim().toLowerCase() && parsed.number === key.number
      ? parsed.authority
      : void 0);
  const canonical = canonicalRepositoryKey(
    `${(authority ?? key.host).trim().toLowerCase()}/${key.repository.trim().toLowerCase()}`,
  );
  const separator = canonical.indexOf("/");
  return {
    host: canonical.slice(0, separator),
    repository: canonical.slice(separator + 1),
    number: key.number,
  };
}
function legacyThreadPullRequestKey(linked, fallbackHost) {
  const parsed = parseChangeRequestUrl(linked.url);
  if (parsed !== null && parsed.number === linked.number) {
    const canonical = canonicalRepositoryKey(`${parsed.host}/${parsed.repository}`);
    if (parsed.authority !== void 0 || canonical.startsWith("dev.azure.com/")) {
      return normalizeThreadPullRequestKey(parsed);
    }
  }
  let host = fallbackHost;
  if (host === void 0) {
    try {
      host = new URL(linked.url).hostname;
    } catch {
      host = "unknown";
    }
  }
  return {
    host: host.trim().toLowerCase() || "unknown",
    repository: linked.repository.trim().toLowerCase(),
    number: linked.number,
  };
}
function threadPullRequestKeysEqual(left, right) {
  return threadPullRequestKeyOf(left) === threadPullRequestKeyOf(right);
}
var normalizedKeys = /* @__PURE__ */ new WeakMap();
function normalizedKeyOf(key) {
  let normalized = normalizedKeys.get(key);
  if (normalized === void 0) {
    normalized = normalizeThreadPullRequestKey(key);
    normalizedKeys.set(key, normalized);
  }
  return normalized;
}
function threadPullRequestKeyOf(key) {
  const normalized = normalizedKeyOf(key);
  return `${normalized.host}/${normalized.repository}#${normalized.number}`;
}
function threadPullRequestsOf(thread) {
  if (thread.pullRequests !== void 0) return thread.pullRequests;
  const linked = thread.linkedPullRequest;
  return linked == null
    ? []
    : [
        {
          ...legacyThreadPullRequestKey(linked),
          url: linked.url,
          source: "manual",
          linkedAt: "1970-01-01T00:00:00.000Z",
          snapshot: null,
          stack: null,
        },
      ];
}
function applyThreadPullRequestLinkUpdate(thread, updated) {
  return {
    ...thread,
    pullRequests: threadPullRequestsOf(thread).map((link) =>
      threadPullRequestKeysEqual(link, updated) ? updated : link,
    ),
  };
}

// upstream:packages/shared/src/orchestrationV2Timeline.ts
function isOrchestrationV2SupersededInterrupt(input) {
  const { item } = input;
  if (item.type !== "run_interrupt_result" || item.runId === null || item.nodeId === null) {
    return false;
  }
  const isSuperseded = input.attempts.some(
    (attempt) =>
      attempt.runId === item.runId &&
      attempt.rootNodeId === item.nodeId &&
      attempt.status === "superseded",
  );
  if (!isSuperseded) {
    return false;
  }
  const hasMatchingRequest = input.items.some(
    (candidate) => candidate.type === "run_interrupt_request" && candidate.runId === item.runId,
  );
  return !hasMatchingRequest;
}
function isOrchestrationV2TurnItemVisible(input) {
  const { item } = input;
  if (
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "rolled_back")
  ) {
    return false;
  }
  if (
    item.type === "user_message" &&
    item.inputIntent === "queued_turn" &&
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "cancelled")
  ) {
    return false;
  }
  return !isOrchestrationV2SupersededInterrupt({
    item,
    attempts: input.attempts,
    items: input.items,
  });
}
function createOrchestrationV2TurnItemVisibility(input) {
  const statuses = new Map(input.runs.map((run) => [run.id, run.status]));
  const supersededRoots = /* @__PURE__ */ new Map();
  for (const attempt of input.attempts) {
    if (attempt.status !== "superseded") continue;
    let roots = supersededRoots.get(attempt.runId);
    if (roots === void 0) supersededRoots.set(attempt.runId, (roots = /* @__PURE__ */ new Set()));
    roots.add(attempt.rootNodeId);
  }
  const interruptRuns = new Set(
    input.items.filter((item) => item.type === "run_interrupt_request").map((item) => item.runId),
  );
  return (item) => {
    const status = item.runId === null ? void 0 : statuses.get(item.runId);
    if (status === "rolled_back") return false;
    if (
      status === "cancelled" &&
      item.type === "user_message" &&
      item.inputIntent === "queued_turn"
    )
      return false;
    return !(
      item.type === "run_interrupt_result" &&
      item.runId !== null &&
      item.nodeId !== null &&
      supersededRoots.get(item.runId)?.has(item.nodeId) === true &&
      !interruptRuns.has(item.runId)
    );
  };
}

// upstream:packages/client-runtime/src/state/orchestrationV2Projection.ts
function upsertEntity(items, item) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}
function removeVisibleItem(rows, sourceItemId) {
  const index = rows.findIndex((row) => row.sourceItemId === sourceItemId);
  if (index === -1) return rows;
  return renumberVisibleItems([...rows.slice(0, index), ...rows.slice(index + 1)]);
}
function renumberVisibleItems(rows) {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}
function shouldShowLocalTurnItem(projection, item) {
  return isOrchestrationV2TurnItemVisible({
    item,
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
}
function activeVisibleTurnItems(projection) {
  const rows = projection.visibleTurnItems;
  const isVisible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  let next = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const keep = row.visibility !== "local" || isVisible(row.item);
    if (!keep) {
      next ??= rows.slice(0, index);
      continue;
    }
    next?.push(row);
  }
  return next === null ? rows : renumberVisibleItems(next);
}
function oldestLocalTurnOrdinal(rows) {
  let oldest = null;
  for (const row of rows) {
    if (row.visibility !== "local") continue;
    if (oldest === null || row.item.ordinal < oldest) {
      oldest = row.item.ordinal;
    }
  }
  return oldest;
}
var UNFINISHED_RUN_STATUSES = /* @__PURE__ */ new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
function shouldDropMissingPartialTurnItem(projection, item, latestLocalTurnOrdinal) {
  if (projection.visibleTurnItems.some((row) => row.sourceItemId === item.id)) {
    return false;
  }
  if (item.runId === null) {
    return isBelowPartialWindow(projection, item, latestLocalTurnOrdinal);
  }
  if (
    projection.runs.some((run) => run.id === item.runId && UNFINISHED_RUN_STATUSES.has(run.status))
  ) {
    return false;
  }
  if (
    projection.visibleTurnItems.some(
      (row) =>
        row.visibility === "local" &&
        row.item.runId === item.runId &&
        row.item.ordinal <= item.ordinal,
    )
  ) {
    return false;
  }
  return isBelowPartialWindow(projection, item, latestLocalTurnOrdinal);
}
function isBelowPartialWindow(projection, item, latestLocalTurnOrdinal) {
  if (
    latestLocalTurnOrdinal !== null &&
    latestLocalTurnOrdinal !== void 0 &&
    item.ordinal <= latestLocalTurnOrdinal
  ) {
    return true;
  }
  const oldest = oldestLocalTurnOrdinal(projection.visibleTurnItems);
  return oldest !== null && item.ordinal < oldest;
}
function upsertVisibleTurnItem(projection, item, partialTimeline, latestLocalTurnOrdinal) {
  const rows = projection.visibleTurnItems;
  let index = rows.length - 1;
  while (index >= 0 && rows[index].sourceItemId !== item.id) index -= 1;
  const next = {
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
  const previous = index === -1 ? void 0 : rows[index];
  if (
    previous !== void 0 &&
    previous.visibility === next.visibility &&
    previous.sourceThreadId === next.sourceThreadId &&
    previous.sourceItemId === next.sourceItemId &&
    previous.item === item
  ) {
    return rows;
  }
  if (
    index === -1 &&
    partialTimeline &&
    shouldDropMissingPartialTurnItem(projection, item, latestLocalTurnOrdinal)
  ) {
    return rows;
  }
  let insertion = rows.length;
  for (let candidate = 0; candidate < rows.length; candidate += 1) {
    const row = rows[candidate];
    if (
      candidate !== index &&
      row.visibility === "local" &&
      (row.item.ordinal > item.ordinal ||
        (row.item.ordinal === item.ordinal &&
          String(row.item.id).localeCompare(String(item.id)) > 0))
    ) {
      insertion = candidate;
      break;
    }
  }
  const updated = [];
  for (let source = 0; source < rows.length; source += 1) {
    if (source === insertion) updated.push(next);
    if (source !== index) updated.push(rows[source]);
  }
  if (insertion === rows.length) updated.push(next);
  for (let position = 0; position < updated.length; position += 1) {
    const row = updated[position];
    if (row.position !== position) updated[position] = { ...row, position };
  }
  return updated;
}
function applyOrchestrationV2ProjectionEvent(projection, event, options) {
  if (projection === null || event.threadId !== projection.thread.id) return projection;
  const partialTimeline = options?.partialTimeline === true;
  const latestLocalTurnOrdinal = options?.latestLocalTurnOrdinal;
  const base = { ...projection, updatedAt: event.occurredAt };
  switch (event.type) {
    case "thread.pull-request-link-updated":
      return {
        ...base,
        thread: applyThreadPullRequestLinkUpdate(projection.thread, event.payload),
      };
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return { ...base, thread: event.payload };
    // Visited tracking is read state, not activity: skip the updatedAt bump.
    case "thread.visited":
    case "thread.marked-unread":
      return { ...projection, thread: event.payload };
    case "run.created":
    case "run.updated": {
      const next = { ...base, runs: upsertEntity(base.runs, event.payload) };
      return { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
    }
    case "run.background-work-cancelled":
      return {
        ...base,
        runs: base.runs.map((run) =>
          run.id === event.payload.runId
            ? {
                ...run,
                restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
              }
            : run,
        ),
      };
    case "run-attempt.created":
    case "run-attempt.updated": {
      const next = { ...base, attempts: upsertEntity(base.attempts, event.payload) };
      return { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
    }
    case "node.updated":
      return { ...base, nodes: upsertEntity(base.nodes, event.payload) };
    case "subagent.updated":
      return { ...base, subagents: upsertEntity(base.subagents, event.payload) };
    case "provider-session.attached":
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertEntity(base.providerSessions, event.payload),
      };
    case "provider-session.detached":
      return {
        ...base,
        providerSessions: base.providerSessions.filter(
          (session) => session.id !== event.payload.providerSessionId,
        ),
      };
    case "provider-thread.updated":
      return { ...base, providerThreads: upsertEntity(base.providerThreads, event.payload) };
    case "provider-turn.updated":
      return {
        ...base,
        providerTurns: upsertEntity(base.providerTurns, {
          ...event.payload,
          ...((event.payload.tokenUsage ??
            base.providerTurns.find((turn) => turn.id === event.payload.id)?.tokenUsage) === void 0
            ? {}
            : {
                tokenUsage:
                  event.payload.tokenUsage ??
                  base.providerTurns.find((turn) => turn.id === event.payload.id)?.tokenUsage,
              }),
        }),
      };
    case "runtime-request.updated":
      return { ...base, runtimeRequests: upsertEntity(base.runtimeRequests, event.payload) };
    case "message.updated":
      return { ...base, messages: upsertEntity(base.messages, event.payload) };
    case "plan.updated":
      return { ...base, plans: upsertEntity(base.plans, event.payload) };
    case "turn-item.updated": {
      let itemIndex = projection.turnItems.length - 1;
      while (itemIndex >= 0 && projection.turnItems[itemIndex].id !== event.payload.id) {
        itemIndex -= 1;
      }
      if (
        partialTimeline &&
        itemIndex === -1 &&
        shouldDropMissingPartialTurnItem(projection, event.payload, latestLocalTurnOrdinal)
      ) {
        return projection;
      }
      const turnItems = [...projection.turnItems];
      if (itemIndex === -1) turnItems.push(event.payload);
      else turnItems[itemIndex] = event.payload;
      const next = { ...base, turnItems };
      const previous = itemIndex === -1 ? void 0 : projection.turnItems[itemIndex];
      const visible =
        event.payload.type === "run_interrupt_request" || previous?.type === "run_interrupt_request"
          ? { ...next, visibleTurnItems: activeVisibleTurnItems(next) }
          : next;
      return {
        ...next,
        visibleTurnItems: shouldShowLocalTurnItem(next, event.payload)
          ? upsertVisibleTurnItem(visible, event.payload, partialTimeline, latestLocalTurnOrdinal)
          : removeVisibleItem(visible.visibleTurnItems, event.payload.id),
      };
    }
    case "checkpoint-scope.created":
      return { ...base, checkpointScopes: upsertEntity(base.checkpointScopes, event.payload) };
    case "checkpoint.captured":
      return { ...base, checkpoints: upsertEntity(base.checkpoints, event.payload) };
    case "checkpoint.rollback-requested":
      return base;
    case "context-handoff.updated":
      return { ...base, contextHandoffs: upsertEntity(base.contextHandoffs, event.payload) };
    case "context-transfer.created":
    case "context-transfer.updated":
      return { ...base, contextTransfers: upsertEntity(base.contextTransfers, event.payload) };
  }
}
export { applyOrchestrationV2ProjectionEvent, deriveThreadQueueWorkflowState };
