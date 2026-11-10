/**
 * The agent's own command inside the wrappers Mend puts around it before the launch's late steps
 * (`withMendMcp`, the seeds): `env KEY=value … <command>`, and the prompt wrapper a stopped
 * terminal's follow-up starts with. Each wrapper keeps the command as a trailing vector, so a late
 * step changes the command without reading a script, and the argv a process row records is the
 * one from before them.
 */

/**
 * Decodes the prompt from base64 chunks and runs the command after them with it as its last
 * argument: `sh -c PROMPT_SCRIPT mend-prompt <chunk count> <chunk>… <command>…`. The exact bytes
 * travel as bounded chunks: a prompt can outgrow one argv word (Core's
 * `SESSION_ARGV_MAX_WORD_BYTES`), and a control plane before 0.39.0-next.712 refused arguments with
 * outer whitespace. The sentinel keeps trailing newlines through command substitution.
 */
export const PROMPT_SCRIPT =
  'n=$1; shift; encoded=; while [ "$n" -gt 0 ]; do encoded="$encoded$1"; shift; n=$((n - 1)); done; ' +
  'prompt="$(printf %s "$encoded" | base64 -d; printf x)"; prompt=${prompt%x}; exec "$@" "$prompt"';

const PROMPT_NAME = "mend-prompt";
const PROMPT_CHUNK_CHARS = 60_000;

/** `command` started with `prompt` as its last argument (`PROMPT_SCRIPT`). */
export const withPrompt = (
  command: ReadonlyArray<string>,
  prompt: string,
): ReadonlyArray<string> => {
  const encoded = Buffer.from(prompt, "utf8").toString("base64");
  const chunks: Array<string> = [];
  for (let offset = 0; offset < encoded.length; offset += PROMPT_CHUNK_CHARS) {
    chunks.push(encoded.slice(offset, offset + PROMPT_CHUNK_CHARS));
  }
  return ["sh", "-c", PROMPT_SCRIPT, PROMPT_NAME, String(chunks.length), ...chunks, ...command];
};

/** Where the command starts in a prompt wrapper's argv; null for any other argv. */
const promptCommandAt = (argv: ReadonlyArray<string>): number | null => {
  if (argv[0] !== "sh" || argv[1] !== "-c" || argv[2] !== PROMPT_SCRIPT) return null;
  if (argv[3] !== PROMPT_NAME || !/^\d+$/.test(argv[4] ?? "")) return null;
  const at = 5 + Number(argv[4]);
  return at < argv.length ? at : null;
};

/** `f` over the command of a prompt wrapper; null when `argv` is not one. */
export const mapPromptCommand = (
  argv: ReadonlyArray<string>,
  f: (command: ReadonlyArray<string>) => ReadonlyArray<string>,
): ReadonlyArray<string> | null => {
  const at = promptCommandAt(argv);
  return at === null ? null : [...argv.slice(0, at), ...f(argv.slice(at))];
};

/** The command a prompt wrapper runs, or `argv` itself. */
export const promptCommandOf = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const at = promptCommandAt(argv);
  return at === null ? argv : argv.slice(at);
};

/** `f` over the agent's own command, through `env KEY=value …` and the prompt wrapper. */
export const mapAgentCommand = (
  argv: ReadonlyArray<string>,
  f: (command: ReadonlyArray<string>) => ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const [head, ...rest] = argv;
  if (head === "env") {
    const commandAt = rest.findIndex((arg) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
    return commandAt < 0
      ? argv
      : ["env", ...rest.slice(0, commandAt), ...mapAgentCommand(rest.slice(commandAt), f)];
  }
  return mapPromptCommand(argv, (command) => mapAgentCommand(command, f)) ?? f(argv);
};
