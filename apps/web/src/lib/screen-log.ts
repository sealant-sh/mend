import type { ScreenActionNote, ScreenLogEntry } from "@mend/domain/workbench";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** One action the agent took, as the log keeps it (typed text keeps only its length). */
export const screenActionWords = ({ action, result }: ScreenActionNote): string => {
  const done = result === "done" ? "" : ` · ${result}`;
  switch (action.kind) {
    case "click":
      return `${action.button === "right" ? "right-click" : (action.count ?? 1) > 1 ? "double-click" : "click"} at ${action.at.x}, ${action.at.y}${done}`;
    case "move":
      return `move to ${action.to.x}, ${action.to.y}${done}`;
    case "drag":
      return `drag ${action.from.x}, ${action.from.y} → ${action.to.x}, ${action.to.y}${done}`;
    case "scroll":
      return `scroll at ${action.at.x}, ${action.at.y}${done}`;
    case "type":
      return `type ${plural(action.length, "character")}${done}`;
    case "key":
      return `press ${action.combo}${done}`;
    case "wait":
      return `wait ${action.ms} ms${done}`;
  }
};

/** What one screen-log entry records, in the screen log's words (ADR 0020). */
export const screenLogWords = (entry: ScreenLogEntry): string => {
  const body = entry.body;
  switch (body._tag) {
    case "Started":
      return "screen started";
    case "Looked":
      return "look";
    case "Acted":
      return body.notes.map(screenActionWords).join(" · ") || "act";
    case "Taken":
      return "took over";
    case "HandedBack":
      return "handed back";
    case "PersonInput":
      return [
        body.clicks > 0 ? plural(body.clicks, "click") : null,
        body.keys > 0 ? plural(body.keys, "key") : null,
        body.pastes > 0 ? plural(body.pastes, "paste") : null,
      ]
        .filter((part) => part !== null)
        .join(", ");
    case "Paused":
      return `input paused · ${body.reason.replace(/-/g, " ")}`;
    case "FramesNotKept":
      return `frames not kept · the ${body.budget} budget is spent`;
    case "Degraded":
      return `degraded · ${body.reason.replace(/-/g, " ")}`;
    case "Ended":
      return `screen ended · ${body.reason.replace(/-/g, " ")}`;
    case "Restarted":
      return "screen started over";
  }
};

/** Who made the entry: the agent, a person, or Mend itself. */
export const screenLogActor = (
  entry: ScreenLogEntry,
  agent: string,
  nameOf: (userId: string) => string,
): string =>
  entry.actor._tag === "Agent"
    ? agent
    : entry.actor._tag === "Person"
      ? nameOf(entry.actor.userId)
      : "Mend";
