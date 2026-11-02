/** The CLI's default agent, also the first launch command in its help catalog. */
const DEFAULT_SETUP_AGENT = "codex";

type SetupAgent = "claude" | "codex";

/** Only named agents and a personal note reach the structured launch path. */
export const parseSetupSessionArgs = (
  args: ReadonlyArray<string>,
):
  | {
      readonly kind: "start";
      readonly agent: SetupAgent;
      readonly launchArgs: ReadonlyArray<string>;
      readonly note: string | null;
    }
  | { readonly kind: "error"; readonly message: string } => {
  let agent: SetupAgent = DEFAULT_SETUP_AGENT;
  let named = false;
  let note: string | null = null;
  const launchArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === "--note" || word === "--project") {
      const value = args[++index];
      if (value === undefined || value.trim() === "")
        return { kind: "error", message: `${word} needs a value` };
      if (word === "--note") note = value;
      else launchArgs.push(word, value);
    } else if (!named && (word === "claude" || word === "codex")) {
      agent = word;
      named = true;
    } else
      return {
        kind: "error",
        message: "mend setup-session [claude|codex] [--note <text>] [--project <p>]",
      };
  }
  return { kind: "start", agent, launchArgs, note };
};

/** Adoption asks only on a terminal; an explicit yes spends the person's login. */
export const offerSetupSession = async (effects: {
  readonly terminal: boolean;
  readonly question: (text: string) => Promise<string>;
  readonly start: (agent: SetupAgent) => Promise<void>;
}): Promise<void> => {
  if (!effects.terminal) return;
  const agent = DEFAULT_SETUP_AGENT;
  const answer = await effects.question(
    `Set up this project with ${agent}? It uses your own ${agent} login. [y/N] `,
  );
  if (/^(y|yes)$/i.test(answer.trim())) await effects.start(agent);
};
