/**
 * Structured session start → harness argv, composed in exactly one place.
 *
 * The composer (web), the CLI, and any future surface describe a start as
 * { prompt, model, effort, permissionMode }; the launch handler turns that
 * into the harness's own flags here. Clients never build harness argv for
 * the composed path — the published CLI stays dependency-free and passes
 * strings through, validated by the API contract.
 */

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
 * `bypass` (and absent) is today's behavior: the engine's
 * `withPermissionDefaults` injects the harness's bypass flag. `ask` opts back
 * into the harness's ordinary approval prompts — the composed argv names a
 * permission flag itself, which suppresses the engine's injection.
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
 * What the `harness_models` table was seeded with (migration 0101), and the words Slack recognises
 * without a database at hand. Not a picker's list: pickers read the server's catalog
 * (`GET /harnesses/models`, `model-catalog.ts`), which an operator edits in place. The contract
 * keeps `model` free-form because harnesses accept ids no list knows yet.
 *
 * Claude is offered by family alias (`fable`, `opus`, `sonnet`, `haiku`): Claude Code resolves
 * each to the latest model of that family, so the list does not go stale when a model ships. As of
 * 2026-10-01 they are Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 4.5.
 *
 * Codex is `codex debug models` (codex-cli 0.159.2, 2026-10-01): the entries it lists, in its own
 * order, its default first, and each model's efforts where it takes fewer than `ultra`.
 */
export const HARNESS_MODEL_SEED: Readonly<Record<string, ReadonlyArray<HarnessModelSeed>>> = {
  claude: [
    { id: "fable", label: "Fable · latest", isDefault: true },
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
};

/** Harnesses whose composed argv actually carries an opening prompt. */
export const PROMPTABLE_HARNESSES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "pi",
]);

/**
 * opencode's permission switch, set at launch (`OPENCODE_PERMISSION`, JSON): `allow` is Mend's
 * stance as for every harness (the workspace is the sandbox), `ask` restores its prompts. Set in
 * the environment, so the user's own opencode config is never written.
 */
export const OPENCODE_PERMISSION_ALLOW = 'OPENCODE_PERMISSION={"*":"allow"}';
const OPENCODE_PERMISSION_ASK = 'OPENCODE_PERMISSION={"*":"ask"}';

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
 * `bypass`/absent emits nothing so the engine's `withPermissionDefaults`
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
      if (start.permissionMode === "ask") argv.push("--permission-mode", "auto");
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
      // The container is the real sandbox; `ask` only restores approval
      // prompts. Naming `--sandbox` suppresses the engine's bypass injection.
      if (start.permissionMode === "ask")
        argv.push("--sandbox", "danger-full-access", "--ask-for-approval", "on-request");
      if (prompt !== null) argv.push(prompt);
      return argv;
    }
    case "opencode": {
      // The TUI, opened on the prompt (`opencode run` is one-shot and would end the session).
      const argv = ["opencode"];
      if (model !== null) argv.push("--model", model);
      if (prompt !== null) argv.push("--prompt", prompt);
      // `ask` names the permission itself, which suppresses the engine's `allow` default.
      return start.permissionMode === "ask" ? ["env", OPENCODE_PERMISSION_ASK, ...argv] : argv;
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
export class ProtocolHarnessUnsupportedError extends Error {
  readonly _tag = "ProtocolHarnessUnsupportedError" as const;
  readonly harness: string;

  constructor(harness: string) {
    super(`Harness "${harness}" does not support protocol mode.`);
    this.harness = harness;
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
