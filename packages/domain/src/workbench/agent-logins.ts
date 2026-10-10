import { Schema } from "effect";

/**
 * Which of a person's own connected logins their Claude and Codex sessions receive
 * (docs/adr/0016, decision 5, amended 2026-10-10). A person's own setting, never an instance's or
 * an organization's, and it only ever narrows what is theirs: no session ever receives another
 * person's login.
 *
 * - `selectedOnly: false` (the default): the session's own agent's login is required, and the
 *   person's other logins (Codex in a Claude session, Claude in a Codex session) are added when
 *   connected, so the agent can run the other CLI on the same person's login.
 * - `selectedOnly: true`: "Give my sessions only the selected agent's login", as before 0.36.1.
 *
 * GitHub is not an agent's login and is given either way. A shell, pi and opencode are open
 * workbenches and receive every login their person has connected either way.
 */
export class AgentLogins extends Schema.Class<AgentLogins>("AgentLogins")({
  selectedOnly: Schema.Boolean,
}) {}

export const DEFAULT_AGENT_LOGINS = new AgentLogins({ selectedOnly: false });
