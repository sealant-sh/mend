/** `GET /api/me/agent-logins`: which of this account's own logins its Claude and Codex sessions get. */
export interface AgentLoginsDto {
  /** True: only the session's own agent's login ("Give my sessions only the selected agent's login"). */
  readonly selectedOnly: boolean;
}

/** What `mend agent-logins …` asks for. */
export type AgentLoginsRequest =
  | { readonly kind: "show" }
  | { readonly kind: "set"; readonly selectedOnly: boolean }
  | { readonly kind: "usage" };

/**
 * `mend agent-logins` shows the setting; `mend agent-logins all` gives Claude and Codex sessions
 * every login you connected (the default), `mend agent-logins selected` only the session's own
 * agent's.
 */
export const parseAgentLoginsArgs = (args: ReadonlyArray<string>): AgentLoginsRequest => {
  if (args.length === 0) return { kind: "show" };
  if (args.length !== 1) return { kind: "usage" };
  switch (args[0]) {
    case "all":
      return { kind: "set", selectedOnly: false };
    case "selected":
      return { kind: "set", selectedOnly: true };
    default:
      return { kind: "usage" };
  }
};

/** One terse line: what a Claude or Codex session of yours receives. */
export const agentLoginsLine = (setting: AgentLoginsDto): string =>
  setting.selectedOnly
    ? "selected · a Claude or Codex session gets its own agent's login only"
    : "all · a Claude session also gets your Codex login, a Codex session your Claude login, when connected";
