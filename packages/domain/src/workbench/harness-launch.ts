/**
 * Structured session start → harness argv, composed in exactly one place.
 *
 * The composer (web), the CLI, and any future surface describe a start as
 * { prompt, model, effort, permissionMode }; the launch handler turns that
 * into the harness's own flags here. Clients never build harness argv for
 * the composed path — the published CLI stays dependency-free and passes
 * strings through, validated by the API contract.
 */

import {
  mendWords,
  type ReaderLine,
  ReaderWords,
  said,
  type SaysReaderWords,
} from "../failure-line.ts";

/**
 * Thinking depth, one shared scale; each harness maps it to its own flag (claude `--effort`, codex
 * `model_reasoning_effort`). `ultra` is codex's own top tier ("maximum reasoning with automatic
 * task delegation"); claude stops at `max`, and so do some codex models. What a model takes is in
 * the server's catalog (`model-catalog.ts`, `catalogEfforts`), applied before a launch is composed;
 * the composer clamps what the harness itself cannot take (`effortFor`).
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** What each harness's CLI accepts at all; a model may take fewer (its catalog row says). */
export const HARNESS_EFFORTS: Readonly<Record<string, ReadonlyArray<EffortLevel>>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
  // pi's `--thinking` takes off, minimal and these five.
  pi: ["low", "medium", "high", "xhigh", "max"],
  // opencode's `--variant` is provider-specific: no shared scale to offer.
  opencode: [],
};

/**
 * The effort a launch passes: a level the harness does not take at all — a saved `ultra` sent to
 * claude — becomes the highest it does, so a stale preference never fails a launch. What the chosen
 * model takes was already applied by the server (`resolveLaunchOptions`).
 */
const effortFor = (harness: string, effort: EffortLevel | undefined): EffortLevel | undefined => {
  const taken = HARNESS_EFFORTS[harness] ?? EFFORT_LEVELS;
  if (effort === undefined || taken.includes(effort)) return effort;
  return taken.at(-1);
};

/**
 * Priority processing. `fast` maps to codex `service_tier=priority`
 * ("1.5x speed, increased usage" per `codex debug models`); claude has no
 * launch-time flag for fast mode (it is the in-session `/fast` toggle), so
 * only harnesses in FAST_CAPABLE_HARNESSES surface the control.
 */
export const SPEED_MODES = ["standard", "fast"] as const;
export type SpeedMode = (typeof SPEED_MODES)[number];

/** Harnesses whose composed argv can request priority processing. */
export const FAST_CAPABLE_HARNESSES: ReadonlySet<string> = new Set(["codex"]);

/**
 * `bypass` (and absent) is today's behavior: `withPermissionDefaults` injects
 * the harness's bypass flag. `ask` opts back into the harness's ordinary
 * approval prompts — the composed argv names a permission flag itself, which
 * suppresses the injection.
 */
export const PERMISSION_MODES = ["bypass", "ask"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** One seeded catalog row; `id` is what the harness CLI accepts verbatim. */
export interface HarnessModelSeed {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  /** The efforts this model takes, when fewer than its harness's (`HARNESS_EFFORTS`). */
  readonly efforts?: ReadonlyArray<EffortLevel>;
}

const CODEX_UP_TO_MAX: ReadonlyArray<EffortLevel> = ["low", "medium", "high", "xhigh", "max"];
const CODEX_UP_TO_XHIGH: ReadonlyArray<EffortLevel> = ["low", "medium", "high", "xhigh"];

/**
 * What the `harness_models` table was seeded with (migration 0102; opencode 0109), and the words Slack recognises
 * without a database at hand. Not a picker's list: pickers read the server's catalog
 * (`GET /harnesses/models`, `model-catalog.ts`), which an operator edits in place. The contract
 * keeps `model` free-form because harnesses accept ids no list knows yet.
 *
 * Claude is offered by family alias (`fable`, `opus`, `sonnet`, `haiku`), none of them the default
 * (`HARNESSES_CHOOSING_THEIR_OWN_MODEL`, migration 0130): Claude Code resolves
 * each to the latest model of that family, so the list does not go stale when a model ships. As of
 * 2026-10-01 they are Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 4.5.
 *
 * Codex is `codex debug models` (codex-cli 0.159.2, 2026-10-01): the entries it lists, in its own
 * order, its default first, and each model's efforts where it takes fewer than `ultra`.
 */
export const HARNESS_MODEL_SEED: Readonly<Record<string, ReadonlyArray<HarnessModelSeed>>> = {
  claude: [
    { id: "fable", label: "Fable · latest", isDefault: false },
    { id: "opus", label: "Opus · latest", isDefault: false },
    { id: "sonnet", label: "Sonnet · latest", isDefault: false },
    { id: "haiku", label: "Haiku · latest", isDefault: false },
  ],
  codex: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: true },
    { id: "gpt-6-astra", label: "GPT-6 Astra", isDefault: false },
    { id: "gpt-6-sol", label: "GPT-6 Sol", isDefault: false },
    { id: "gpt-6-luna", label: "GPT-6 Luna", isDefault: false, efforts: CODEX_UP_TO_MAX },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", isDefault: false },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", isDefault: false },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", isDefault: false, efforts: CODEX_UP_TO_MAX },
    { id: "gpt-5.5", label: "GPT-5.5", isDefault: false, efforts: CODEX_UP_TO_XHIGH },
  ],
  // opencode on the ChatGPT login (migration 0109): the Codex models above as `opencode models
  // openai` lists them (opencode 1.18.34, 2026-10-04). No default: a launch that names none leaves
  // the choice to opencode (`HARNESSES_CHOOSING_THEIR_OWN_MODEL`). opencode takes no shared effort
  // scale (`HARNESS_EFFORTS`).
  opencode: [
    { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: false },
    { id: "openai/gpt-6-astra", label: "GPT-6 Astra", isDefault: false },
    { id: "openai/gpt-6-sol", label: "GPT-6 Sol", isDefault: false },
    { id: "openai/gpt-6-luna", label: "GPT-6 Luna", isDefault: false },
    { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", isDefault: false },
    { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", isDefault: false },
    { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", isDefault: false },
    { id: "openai/gpt-5.5", label: "GPT-5.5", isDefault: false },
  ],
};

/**
 * The model opencode opens on when nothing else chose one: the Codex default above, through the
 * ChatGPT login Mend writes into opencode (`harness-seeds.ts` in @mend/sessions). opencode's own
 * fallback takes the first provider it can see, and in a workspace that is GitHub Copilot, from
 * the `GITHUB_TOKEN` Mend gives for git: a token Copilot refuses ("The requested model is not
 * available for integrator opencode", seen on the box 2026-10-04). Written as opencode's last
 * used model, so `--model`, the user's config and a model picked in opencode still decide first.
 */
export const OPENCODE_DEFAULT_MODEL = "openai/gpt-6.1-sol";

/**
 * Harnesses whose launch names no model unless someone chose one: the catalog lists their models
 * for a picker, but its first row is not a default, so an absent choice stays absent and the
 * harness decides. opencode decides by its own order: `--model`, the project's and the user's
 * opencode config, the model it last used (where `OPENCODE_DEFAULT_MODEL` is written when it has
 * none); a catalog default sent as `--model` would beat the person's own config. Claude Code
 * decides as it does for a `claude` run by hand: the person's and the repository's settings, else
 * its own default (Yiannis, 2026-10-12: "by default have the default claude model"). A row an
 * operator flags as the default is still the default.
 */
export const HARNESSES_CHOOSING_THEIR_OWN_MODEL: ReadonlySet<string> = new Set([
  "opencode",
  "claude",
]);

/** Harnesses whose composed argv actually carries an opening prompt. */
export const PROMPTABLE_HARNESSES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "pi",
]);

/**
 * Whether review comments can be sent to a session of this harness: delivery starts its agent
 * again with them as the opening prompt, and a `mend run` command or a shell has no agent to
 * start (verify 2026-10-10).
 */
export const takesReviewFollowUp = (harness: string): boolean => PROMPTABLE_HARNESSES.has(harness);

/** What a review reads where its session has no agent to send it to (`takesReviewFollowUp`). */
export const noReviewFollowUpLine = (harness: string): string =>
  `This ${harness} session has no agent to send the review to. Start an agent in this worktree, then send it.`;

/**
 * Whether a session resumes on its own harness: an agent comes back with its conversation and a
 * shell opens again, but a `mend run` command has nothing to resume (verify 2026-10-11). Such a
 * session still opens as a shell, or as another harness, in its worktree.
 */
export const resumesOwnHarness = (harness: string): boolean =>
  PROMPTABLE_HARNESSES.has(harness) || harness === "shell";

/** What a resume on the session's own harness reads where it has none (`resumesOwnHarness`). */
export const noResumeLine = (harness: string): string =>
  `This ${harness} session has no agent to resume. Resume it as a shell, or start another session in its worktree.`;

/**
 * opencode's permission switch, set at launch (`OPENCODE_PERMISSION`, JSON): `allow` is Mend's
 * stance as for every harness (the workspace is the sandbox), `ask` restores its prompts. Set in
 * the environment, so the user's own opencode config is never written.
 */
const OPENCODE_PERMISSION_ALLOW = 'OPENCODE_PERMISSION={"*":"allow"}';
const OPENCODE_PERMISSION_ASK = 'OPENCODE_PERMISSION={"*":"ask"}';

interface PermissionArgsOf {
  readonly claude: { readonly flags: ReadonlyArray<string> };
  readonly codex: { readonly flags: ReadonlyArray<string> };
  readonly opencode: { readonly env: string };
}

/**
 * Each harness's own permission for a mode. `ask` restores approval prompts; the container is the
 * real sandbox, so codex's `ask` keeps full access. `bypass` is the default `withPermissionDefaults`
 * gives a launch that names none. opencode reads its permission from the environment.
 */
const PERMISSION_ARGS: {
  readonly [Harness in keyof PermissionArgsOf]: Readonly<
    Record<PermissionMode, PermissionArgsOf[Harness]>
  >;
} = {
  claude: {
    ask: { flags: ["--permission-mode", "auto"] },
    bypass: { flags: ["--dangerously-skip-permissions"] },
  },
  codex: {
    ask: { flags: ["--sandbox", "danger-full-access", "--ask-for-approval", "on-request"] },
    bypass: { flags: ["--dangerously-bypass-approvals-and-sandbox"] },
  },
  opencode: {
    ask: { env: OPENCODE_PERMISSION_ASK },
    bypass: { env: OPENCODE_PERMISSION_ALLOW },
  },
};

/**
 * A harness's own permission for `mode`: the flags it reads after its name, or opencode's
 * assignment for `env` to set ahead of it. Typed per harness, so the assignment is never spliced
 * into an argv as a flag.
 */
const permissionArgs = <Harness extends keyof PermissionArgsOf>(
  harness: Harness,
  mode: PermissionMode,
): PermissionArgsOf[Harness] => PERMISSION_ARGS[harness][mode];

/** The options a permission is named by. codex's `--yolo` is its bypass flag's alias. */
const PERMISSION_OPTIONS = {
  claude: new Set(["--permission-mode", "--dangerously-skip-permissions"]),
  codex: new Set([
    "--sandbox",
    "-s",
    "--ask-for-approval",
    "-a",
    "--full-auto",
    "--approve-for-me",
    "--yolo",
    "--dangerously-bypass-approvals-and-sandbox",
  ]),
} as const;

/**
 * The options that take a value. Claude's `--resume`/`-r` take an optional one, so they are read
 * as flags here: an option after them is never their value.
 */
const VALUE_OPTIONS: Readonly<Record<"claude" | "codex", ReadonlySet<string>>> = {
  claude: new Set(["--model", "--effort", "--permission-mode", "--session-id"]),
  codex: new Set([
    "--model",
    "-m",
    "-c",
    "--config",
    "--sandbox",
    "-s",
    "--ask-for-approval",
    "-a",
    "--profile",
    "-p",
    "--cd",
    "-C",
  ]),
};

interface ArgvOption {
  readonly name: string;
  readonly value: string | null;
  readonly tokens: ReadonlyArray<string>;
}

/** The options of `argv` after its head, up to `--`: what follows that is a prompt. */
const optionsIn = (harness: "claude" | "codex", argv: ReadonlyArray<string>) => {
  const options: ArgvOption[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") break;
    if (!token.startsWith("-")) continue;
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    if (equals > 0) {
      options.push({
        name: token.slice(0, equals),
        value: token.slice(equals + 1),
        tokens: [token],
      });
    } else if (
      !token.startsWith("--") &&
      VALUE_OPTIONS[harness].has(token.slice(0, 2)) &&
      token.length > 2
    ) {
      // codex reads `-sread-only` and `-s=read-only` as `-s read-only`.
      const value = token.slice(2);
      options.push({
        name: token.slice(0, 2),
        value: value.startsWith("=") ? value.slice(1) : value,
        tokens: [token],
      });
    } else if (VALUE_OPTIONS[harness].has(token) && index + 1 < argv.length) {
      const value = argv[index + 1] ?? "";
      options.push({ name: token, value, tokens: [token, value] });
      index += 1;
    } else {
      options.push({ name: token, value: null, tokens: [token] });
    }
  }
  return options;
};

const permissionOptionsIn = (harness: "claude" | "codex", argv: ReadonlyArray<string>) =>
  optionsIn(harness, argv).filter((option) => PERMISSION_OPTIONS[harness].has(option.name));

/**
 * The tokens by which `argv` names the harness's own permission, verbatim and in order: what a
 * Resume on the same harness carries over.
 */
export const permissionFlagsIn = (
  harness: "claude" | "codex",
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => permissionOptionsIn(harness, argv).flatMap((option) => option.tokens);

/**
 * A terminal launch's argv with Mend's permission where it names none: the harness's bypass (the
 * workspace is the sandbox).
 */
export const withPermissionDefaults = (
  harness: string,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const [head, ...rest] = argv;
  if (
    (harness === "claude" || harness === "codex") &&
    head === harness &&
    permissionOptionsIn(harness, argv).length === 0
  ) {
    return [head, ...PERMISSION_ARGS[harness].bypass.flags, ...rest];
  }
  // opencode reads its permissions from the environment; an argv that sets them itself (`env …`,
  // the composed `ask`) is left alone.
  if (harness === "opencode" && head === "opencode") {
    return ["env", PERMISSION_ARGS.opencode.bypass.env, ...argv];
  }
  // pi asks nothing per tool call; it does ask whether to trust the repository's own `.pi`
  // resources, which the user decided when they adopted it.
  if (
    harness === "pi" &&
    head === "pi" &&
    !argv.includes("--approve") &&
    !argv.includes("--no-approve")
  ) {
    return ["pi", "--approve", ...rest];
  }
  return argv;
};

export const terminalPermissionMode = (
  harness: string,
  argv: ReadonlyArray<string>,
): PermissionMode | null => {
  switch (harness) {
    case "claude":
    case "codex": {
      if (argv[0] !== harness) return null;
      const named = new Map(
        permissionOptionsIn(harness, argv).map((option) => [option.name, option.value]),
      );
      if (named.size === 0) return "bypass";
      if (harness === "claude") {
        return named.has("--dangerously-skip-permissions") ||
          named.get("--permission-mode") === "bypassPermissions"
          ? "bypass"
          : "ask";
      }
      if (named.has("--dangerously-bypass-approvals-and-sandbox") || named.has("--yolo")) {
        return "bypass";
      }
      return (named.get("--ask-for-approval") ?? named.get("-a")) === "never" ? "bypass" : "ask";
    }
    case "opencode": {
      if (argv[0] === "opencode") return "bypass";
      if (argv[0] !== "env" || !argv.includes("opencode")) return null;
      const assignments = argv.slice(1, argv.indexOf("opencode"));
      if (assignments.includes(OPENCODE_PERMISSION_ASK)) return "ask";
      return assignments.includes(OPENCODE_PERMISSION_ALLOW) ? "bypass" : null;
    }
    default:
      return null;
  }
};

/** A structured start; every field optional — all-absent composes the bare harness. */
export interface LaunchStart {
  readonly mode?: "pty" | "protocol" | undefined;
  readonly prompt?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: EffortLevel | undefined;
  readonly permissionMode?: PermissionMode | undefined;
  readonly speed?: SpeedMode | undefined;
}

const trimmed = (value: string | undefined): string | null => {
  const body = value?.trim() ?? "";
  return body === "" ? null : body;
};

/**
 * Compose the PTY argv for a structured start. The prompt rides as the last
 * positional (the harness opens with it as the first user message); permission
 * `bypass`/absent emits nothing so `withPermissionDefaults`
 * injects the bypass flag exactly as for a bare launch.
 */
export const composeLaunchArgv = (harness: string, start: LaunchStart): ReadonlyArray<string> => {
  const prompt = trimmed(start.prompt);
  const model = trimmed(start.model);
  switch (harness) {
    case "claude": {
      const argv = ["claude"];
      if (model !== null) argv.push("--model", model);
      const effort = effortFor("claude", start.effort);
      if (effort !== undefined) argv.push("--effort", effort);
      if (start.permissionMode === "ask") argv.push(...permissionArgs("claude", "ask").flags);
      if (prompt !== null) argv.push(prompt);
      return argv;
    }
    case "codex": {
      const argv = ["codex"];
      if (model !== null) argv.push("--model", model);
      const effort = effortFor("codex", start.effort);
      if (effort !== undefined) argv.push("-c", `model_reasoning_effort=${effort}`);
      // Priority processing; codex warns and omits the tier when the model
      // doesn't advertise it, so this degrades harmlessly.
      if (start.speed === "fast") argv.push("-c", "service_tier=priority");
      if (start.permissionMode === "ask") argv.push(...permissionArgs("codex", "ask").flags);
      if (prompt !== null) argv.push(prompt);
      return argv;
    }
    case "opencode": {
      // The TUI, opened on the prompt (`opencode run` is one-shot and would end the session).
      const argv = ["opencode"];
      if (model !== null) argv.push("--model", model);
      if (prompt !== null) argv.push("--prompt", prompt);
      // `ask` names the permission itself, which suppresses the `allow` default.
      return start.permissionMode === "ask"
        ? ["env", permissionArgs("opencode", "ask").env, ...argv]
        : argv;
    }
    case "pi": {
      // pi has no approval prompts to bypass (it relies on the sandbox, which the workspace is);
      // `ask` therefore changes nothing for it.
      const argv = ["pi"];
      if (model !== null) argv.push("--model", model);
      const effort = effortFor("pi", start.effort);
      if (effort !== undefined) argv.push("--thinking", effort);
      if (prompt !== null) argv.push(prompt);
      return argv;
    }
    case "shell":
      return ["bash"];
    default:
      return [harness];
  }
};

/** A harness has no supported structured byte protocol in Mend. */
export class ProtocolHarnessUnsupportedError extends Error implements SaysReaderWords {
  readonly _tag = "ProtocolHarnessUnsupportedError" as const;
  readonly harness: string;

  constructor(harness: string) {
    super(`Harness "${harness}" does not support protocol mode.`);
    this.harness = harness;
  }

  get [ReaderWords](): ReaderLine {
    return said`Harness "${mendWords(this.harness)}" does not support protocol mode.`;
  }
}

/** Compose the long-lived protocol process argv. Model and effort stay on provider turns. */
export const composeProtocolArgv = (
  harness: string,
  start: LaunchStart,
  providerSessionId?: string,
): ReadonlyArray<string> | ProtocolHarnessUnsupportedError => {
  const model = trimmed(start.model);
  switch (harness) {
    case "codex":
      return ["codex", "app-server"];
    case "claude": {
      const argv = [
        "claude",
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
      ];
      if (providerSessionId === undefined) argv.push("--session-id", crypto.randomUUID());
      else argv.push("--resume", providerSessionId);
      if (model !== null) argv.push("--model", model);
      const effort = effortFor("claude", start.effort);
      if (effort !== undefined) argv.push("--effort", effort);
      if (start.permissionMode !== "ask") {
        argv.push("--permission-mode", "bypassPermissions");
      }
      return argv;
    }
    default:
      return new ProtocolHarnessUnsupportedError(harness);
  }
};
