// Fixture answers for the new web app's session recipes (new-web-session, new-web-write): what an
// agent's turn makes, laid over a real session's reads in the browser. Not a recipe of its own.

/** superjson's answer for plain JSON with ISO dates at `datePaths` (dotted). */
export const superjson = (json, datePaths) => ({
  json,
  meta: { values: Object.fromEntries(datePaths.map((path) => [path, ["Date"]])), v: 1 },
});

/** One conversation window, as the three history reads answer it. */
export const history = ({ turns, items, requests = [] }) => ({
  "sessions.historyTurns": superjson(
    { turns },
    turns.flatMap((turn, index) => [
      ...["createdAt", "startedAt", "endedAt"]
        .filter((field) => turn[field] !== null)
        .map((field) => `turns.${index}.${field}`),
      ...(turn.steers ?? []).map((_, at) => `turns.${index}.steers.${at}.createdAt`),
    ]),
  ),
  "sessions.historyItems": superjson(
    { items, next: null, feed: items.length },
    items.flatMap((_, index) => [`items.${index}.createdAt`, `items.${index}.updatedAt`]),
  ),
  "sessions.historyRequests": superjson(
    { requests },
    requests.flatMap((request, index) => [
      `requests.${index}.createdAt`,
      ...(request.decidedAt === null || request.decidedAt === undefined
        ? []
        : [`requests.${index}.decidedAt`]),
    ]),
  ),
});

export const empty = () => history({ turns: [], items: [] });

export const turn = (sessionId, me, ordinal, status, input, start, end, extra = {}) => ({
  id: `fixture-turn-${ordinal + 1}`,
  sessionId,
  ordinal,
  origin: "request",
  author: me,
  billedUserId: me,
  billedAccountName: null,
  steerSender: null,
  fromSteer: null,
  clientMessageId: null,
  steers: [],
  input,
  status,
  error: null,
  createdAt: start,
  startedAt: start,
  endedAt: end,
  unreachable: null,
  ...extra,
});

let seq = 0;
export const item = (turnId, kind, status, start, end, fields = {}) => {
  seq += 1;
  return {
    id: `fixture-item-${seq}`,
    seq,
    turnId,
    kind,
    status,
    title: null,
    text: null,
    data: null,
    createdAt: start,
    updatedAt: end,
    ...fields,
  };
};

/**
 * A request the agent asked in `turnId`, waiting unless `fields` settle it. Each kind's `detail` is
 * what its adapter records: Codex's params for a command or file change, Claude's tool name and
 * input for a tool permission.
 */
export const request = (id, turnId, kind, createdAt, fields = {}) => ({
  id,
  sessionId: "fixture",
  processId: "fixture-process",
  turnId,
  kind,
  providerRequestId: `${id}-provider`,
  providerItemId: null,
  title: null,
  detail: null,
  questions: null,
  status: "pending",
  decision: null,
  decidedBy: null,
  answers: null,
  createdAt,
  decidedAt: null,
  ...fields,
});

export const command = (turnId, status, start, end, text) =>
  item(turnId, "command-execution", status, start, end, {
    title: text,
    data: { type: "commandExecution", command: text, exitCode: status === "failed" ? 1 : 0 },
  });

/**
 * The session's real detail with a fixture's status and summary in place; for a session the
 * fixture never let start, no agent (its date fields leave superjson's meta with it); for one whose
 * fixture is a live conversation (`protocolAgent`), a running conversation-mode agent.
 */
export const patchDetail = (data, patch) => {
  const json = structuredClone(data.json);
  const values = { ...data.meta?.values };
  json.session.status = patch.status;
  if ("summary" in patch) json.session.summary = patch.summary;
  if ("sealantRunId" in patch) json.session.sealantRunId = patch.sealantRunId;
  // The fixtures are an agent's turns: the session reads as Claude Code's, not a command's.
  if ("harness" in patch) json.session.harness = patch.harness;
  // A conversation whose agent runs now: Claude Code in conversation mode, launched skipping its
  // permission prompts, so the composer under it takes messages.
  if (patch.protocolAgent === true && json.currentAgent !== null) {
    json.currentAgent.kind = "agent-protocol";
    json.currentAgent.status = "running";
    json.currentAgent.exitedAt = null;
    json.currentAgent.protocolOptions = { model: null, effort: null, permissionMode: "bypass" };
    delete values["currentAgent.exitedAt"];
  }
  // Someone who may not steer the session, which another member owns: no controls.
  if (patch.viewerSteers === false) json.control = { ...json.control, steer: false, own: false };
  if ("ownerUserId" in patch) json.session.ownerUserId = patch.ownerUserId;
  if (patch.dropAgent === true) {
    json.currentAgent = null;
    json.processes = [];
    for (const key of Object.keys(values))
      if (key.startsWith("currentAgent") || key.startsWith("processes")) delete values[key];
  }
  return { json, meta: { ...data.meta, values } };
};
