/**
 * The conversation home of a shared conversation (docs/adr/0016-per-person-harness-homes.md,
 * decision 6, Delivery 17), the parts that need no engine: where a once-shared session's
 * conversation lives (`C`, in its owner's saved directory), the fixed harness directory every
 * agent process of the session runs with (`H`, outside every capture root), the neutral seed that
 * keeps both people's personal memory, instructions and settings out of the request, the Claude
 * settings passed inline with `--settings`, and the scripts of the restart path: the move into `C`,
 * the staging of `H.next` as the sender while the old process stops, and the exchange once the old
 * process group is empty. Everything here is reached only in a person-layout executor, for a
 * protocol Claude or Codex session that shared control has been turned on for.
 */
import { type LinuxIdentity, MEND_GROUP, linuxHomeOf } from "@mend/domain/workbench";

import { CLAUDE_NEUTRAL_ENV, claudeSettingsArgOf } from "./claude-settings.ts";
import { assertScriptSafe, PEOPLE_DIR, savedDirOf } from "./harness-layout.ts";
import { shellQuote } from "./workspace-files.ts";

export {
  CLAUDE_NEUTRAL_ENV,
  type ClaudeSettingsKind,
  claudeSettingsArgOf,
  claudeSettingsOf,
} from "./claude-settings.ts";

// ─── places ──────────────────────────────────────────────────────────────────

/** Where every conversation home lives: under `/run`, outside every capture root. */
export const CONVERSATION_HOMES = "/run/mend/conv";

/** `H`: the harness directory every agent process of a once-shared session runs with. */
export const conversationHomeOf = (sessionId: string, root = CONVERSATION_HOMES): string =>
  `${root}/${safeSessionId(sessionId)}`;

/** `H.next`: where the next process's seed is staged, as its sender, while the old one stops. */
export const stagedHomeOf = (sessionId: string, root = CONVERSATION_HOMES): string =>
  `${conversationHomeOf(sessionId, root)}.next`;

/** `C`: the conversation's files, in its owner's saved directory, saved with every capture. */
export const conversationDirOf = (harnessHome: string, owner: string, sessionId: string): string =>
  `${savedDirOf(harnessHome, owner)}/conversations/${safeSessionId(sessionId)}`;

/**
 * The links that place a conversation in `C`, one at the top of each (decision 6): everything
 * below is a real directory in `C`, which Claude requires for tool results and where Codex writes
 * sub-agent rollouts. Codex's `history.jsonl` (the TUI's prompt history, re-`chmod`ed 0600 on
 * every append) and Claude's file history (never saved, decision 2) are not linked: they stay in
 * `H` and end at the next change of sender.
 */
export const CONVERSATION_LINKS: Readonly<
  Record<
    "claude" | "codex",
    ReadonlyArray<{ readonly path: string; readonly kind: "directory" | "file" }>
  >
> = {
  claude: [
    { path: ".claude/projects", kind: "directory" },
    { path: ".claude/plans", kind: "directory" },
    { path: ".claude/todos", kind: "directory" },
    { path: ".claude/tasks", kind: "directory" },
    { path: ".claude/jobs", kind: "directory" },
    { path: ".claude/teams", kind: "directory" },
  ],
  codex: [
    { path: ".codex/sessions", kind: "directory" },
    { path: ".codex/archived_sessions", kind: "directory" },
    { path: ".codex/session_index.jsonl", kind: "file" },
  ],
};

/** The harnesses a conversation home is for: opencode is one person's, pi is terminal-only. */
export type ConversationHarness = "claude" | "codex";

export const isConversationHarness = (harness: string | null): harness is ConversationHarness =>
  harness === "claude" || harness === "codex";

/** Claude names a project directory after the working directory: `/workspace/repo` → `-workspace-repo`. */
export const claudeProjectDirOf = (cwd: string): string => cwd.replaceAll(/[^A-Za-z0-9]/g, "-");

// ─── what a process gets ─────────────────────────────────────────────────────

/** Claude's default model alias, as Mend's own seed sets it where nothing else does. */
const CLAUDE_DEFAULT_MODEL = "fable";

/**
 * Claude's seeded files in `H/.claude`: no `CLAUDE.md`, `rules/`, agents, commands, skills,
 * output styles, plugins, workflows, routines, agent memory or hooks; no user MCP servers in
 * `.claude.json` and never `hasClaudeMdExternalIncludesApproved`, so a repository `CLAUDE.md`
 * cannot `@~/`-import a personal file; `settings.json` with automatic memory off. What loads is the
 * repository's own `CLAUDE.md`, `.claude/` and `.mcp.json`.
 */
export const claudeNeutralSeed = (): Readonly<Record<string, string>> => ({
  ".claude/.claude.json": `${JSON.stringify(
    {
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: {
        "/workspace/repo": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    },
    null,
    2,
  )}\n`,
  ".claude/settings.json": `${JSON.stringify(
    {
      autoMemoryEnabled: false,
      skipDangerousModePermissionPrompt: true,
      model: CLAUDE_DEFAULT_MODEL,
    },
    null,
    2,
  )}\n`,
});

/** A TOML basic string. */
const tomlString = (value: string): string =>
  `"${[...value]
    .filter((char) => (char.codePointAt(0) ?? 0) >= 0x20 && char !== "\u007f")
    .join("")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;

/**
 * Codex's seeded `H/.codex/config.toml`: the session's model, memories off, plugins off (otherwise
 * every fresh `H` starts Codex's curated-plugin sync, a `git clone` that outlives the app-server
 * and writes into the old `H`), no personal `mcp_servers`, and the agent's tool commands run with
 * the sender's own home while the app-server itself runs with `HOME=H` (so Codex's
 * `$HOME/.agents/skills` finds nothing personal). The worktree is trusted, as Mend's own seed says.
 */
export const codexNeutralConfig = (input: {
  readonly senderHome: string;
  readonly model: string | null;
}): string =>
  [
    ...(input.model === null ? [] : [`model = ${tomlString(input.model)}`]),
    ``,
    `[features]`,
    `memories = false`,
    `plugins = false`,
    `daemon_auto_start = false`,
    `shell_snapshot = false`,
    ``,
    `[shell_environment_policy]`,
    `set = { HOME = ${tomlString(input.senderHome)} }`,
    ``,
    `[projects."/workspace/repo"]`,
    `trust_level = "trusted"`,
    ``,
  ].join("\n");

/** The variable every process of a once-shared session carries: what the emptiness check finds. */
export const CONVERSATION_MARKER = "MEND_CONVERSATION";

/**
 * The environment of an agent process of a once-shared session, over the sender's own person
 * environment (`personProcessEnv`): its harness directory at `H`, Codex's index there too (never
 * the sender's saved one, so the owner's thread enters no person's saved index or memory), the
 * neutral switches in the environment as well as in the inline settings (older Claude versions),
 * and the marker the emptiness check looks for.
 */
export const conversationProcessEnv = (input: {
  readonly harness: ConversationHarness;
  readonly sessionId: string;
  readonly personEnv: Readonly<Record<string, string>>;
  readonly root?: string;
}): Readonly<Record<string, string>> => {
  const home = conversationHomeOf(input.sessionId, input.root);
  const common = {
    ...input.personEnv,
    [CONVERSATION_MARKER]: safeSessionId(input.sessionId),
    IS_SANDBOX: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  if (input.harness === "claude") {
    // Claude keeps no Codex index: the sender's saved one is not named at all.
    const rest = Object.fromEntries(
      Object.entries(common).filter(([key]) => key !== "CODEX_SQLITE_HOME"),
    );
    return { ...rest, ...CLAUDE_NEUTRAL_ENV, CLAUDE_CONFIG_DIR: `${home}/.claude` };
  }
  return {
    ...common,
    HOME: home,
    CODEX_HOME: `${home}/.codex`,
    CODEX_SQLITE_HOME: `${home}/.codex`,
  };
};

/** Codex's switches for a conversation home, on the command line as well as in its config. */
const CODEX_CONVERSATION_FLAGS = [
  "-c",
  "features.memories=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.daemon_auto_start=false",
  "-c",
  "features.shell_snapshot=false",
] as const;

/**
 * A protocol agent's command line in a conversation home: started directly (no seed, no shell
 * profile), Claude with the neutral settings inline and resumed by the full path of its transcript,
 * never by an id another conversation could answer to (decision 6, "Resume never forks").
 */
export const conversationArgv = (input: {
  readonly harness: ConversationHarness;
  /** The protocol command line as `composeProtocolArgv` made it. */
  readonly argv: ReadonlyArray<string>;
  /** The transcript a resume continues, under `H`; null for a new conversation. */
  readonly resumePath: string | null;
}): ReadonlyArray<string> => {
  if (input.harness === "codex") {
    const [head, ...rest] = input.argv;
    return head === "codex" ? [head, ...CODEX_CONVERSATION_FLAGS, ...rest] : input.argv;
  }
  const argv = [...input.argv];
  const resume = argv.indexOf("--resume");
  if (resume >= 0 && input.resumePath !== null) argv[resume + 1] = input.resumePath;
  return [...argv, "--settings", claudeSettingsArgOf("neutral")];
};

// ─── the scripts ─────────────────────────────────────────────────────────────

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9-]{8,64}$/;

/** A session id goes into paths and scripts only after this. */
export const safeSessionId = (sessionId: string): string => {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`session id ${JSON.stringify(sessionId)} cannot name a directory`);
  }
  return sessionId;
};

const safeProviderId = (id: string): string => {
  if (!SAFE_PROVIDER_ID.test(id)) {
    throw new Error(`provider session id ${JSON.stringify(id)} cannot name a file`);
  }
  return id;
};

/** What a conversation line on stdout says (`parseConversationReport`). */
export const CONVERSATION_LINE = "mend-conv";

/** Where the tests put what the executor keeps at fixed paths; the executor's own when absent. */
export interface ConversationPlaces {
  readonly harnessHome: string;
  /** The conversation homes' root; `CONVERSATION_HOMES` unless a test names another. */
  readonly homesRoot?: string;
  /** Where processes are listed; `/proc` unless a test names another. */
  readonly procRoot?: string;
  /** How long the emptiness check waits for the old process group, in tenths of a second. */
  readonly waitTenths?: number;
}

/**
 * Runs `script` as `person` when root (through `setpriv`, which the person layout requires),
 * else as the caller (the tests). `umask` 0002 there, so what they make in `C` stays the group's.
 */
const asPerson = (person: LinuxIdentity, script: string): string =>
  `as_p=${shellQuote(`umask 002\n${script}`)}\n` +
  `if [ "$root" = 1 ]; then (cd / && setpriv --reuid=${person.uid} --regid=${MEND_GROUP.gid} --clear-groups -- sh -c "$as_p") || exit 1; ` +
  `else sh -c "$as_p" || exit 1; fi`;

/**
 * The move into `C` (decision 6), as the owner: Claude's transcript, its `<id>/` directory (tool
 * results, sub-agents), its task list and todos; Codex's rollout and the rollouts of the threads it
 * spawned (whose first line names it). From the owner's saved directory `P` into `C`, never over
 * anything already there (what `C` holds already is kept and the personal copy left in place),
 * and nothing deleted. `C` is made owned by the owner, group `mend`, setgid, 2770, with a default
 * ACL granting the group `rwX` where the filesystem has ACLs. Idempotent: a second run moves
 * nothing. Prints `mend-conv moved <n>` and `mend-conv kept <path>` for each personal copy left
 * because `C` held one.
 */
const moveIntoConversationAsOwner = (input: {
  readonly harness: ConversationHarness;
  readonly saved: string;
  readonly conversation: string;
  readonly providerSessionId: string | null;
}): string => {
  const q = shellQuote;
  const id = input.providerSessionId === null ? null : safeProviderId(input.providerSessionId);
  const lines = [
    `set -e`,
    `P=${q(input.saved)}; C=${q(input.conversation)}; moved=0`,
    `fail() { printf 'mend: %s\\n' "$1" >&2; exit 1; }`,
    `for p in "$P/conversations" "$C"; do [ -L "$p" ] && fail "unexpected link: $p"; done; :`,
    `mkdir -p "$P/conversations" "$C"`,
    `chmod 2770 "$C"`,
    `setfacl -m d:g::rwX -m g::rwX "$C" >/dev/null 2>&1 || true`,
    // One entry, never over another: a directory merges entry by entry.
    `put() { local s t c; s="$1"; t="$2"; [ -e "$s" ] || [ -L "$s" ] || return 0; mkdir -p "$(dirname "$t")"; ` +
      `if [ -d "$s" ] && [ ! -L "$s" ] && [ -d "$t" ] && [ ! -L "$t" ]; then ` +
      `for c in "$s"/* "$s"/.[!.]* "$s"/..?*; do [ -e "$c" ] || [ -L "$c" ] || continue; put "$c" "$t/\${c##*/}"; done; rmdir "$s" 2>/dev/null || true; ` +
      `elif [ -e "$t" ] || [ -L "$t" ]; then printf '%s kept %s\\n' ${CONVERSATION_LINE} "$s"; ` +
      `else mv -T -- "$s" "$t"; moved=$((moved + 1)); fi; }`,
  ];
  if (id !== null && input.harness === "claude") {
    lines.push(
      `for d in "$P"/.claude/projects/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); ` +
        `put "\${d}${id}.jsonl" "$C/.claude/projects/$n/${id}.jsonl"; put "\${d}${id}" "$C/.claude/projects/$n/${id}"; done`,
      `put "$P/.claude/tasks/${id}" "$C/.claude/tasks/${id}"`,
      `for f in "$P"/.claude/todos/${id}-*.json; do [ -e "$f" ] || continue; put "$f" "$C/.claude/todos/$(basename "$f")"; done`,
    );
  }
  if (id !== null && input.harness === "codex") {
    lines.push(
      // The thread's own rollout, and every rollout whose first line (its session meta) names it:
      // the threads it spawned.
      `for top in sessions archived_sessions; do [ -d "$P/.codex/$top" ] || continue; ` +
        `list=$(mktemp); find "$P/.codex/$top" -type f -name 'rollout-*.jsonl' > "$list.all"; ` +
        `while IFS= read -r f; do case "$f" in *-${id}.jsonl) ;; *) head -n 1 "$f" 2>/dev/null | grep -Eq ${q(`"(parent_thread_id|forked_from_id)" *: *"${id}"`)} || continue ;; esac; ` +
        `printf '%s\\n' "$f" >> "$list"; done < "$list.all"; ` +
        `if [ -f "$list" ]; then while IFS= read -r f; do put "$f" "$C/.codex/$top/\${f#"$P/.codex/$top/"}"; done < "$list"; fi; ` +
        `rm -f "$list" "$list.all"; done`,
      `if [ -f "$P/.codex/session_index.jsonl" ]; then mkdir -p "$C/.codex"; ` +
        `touch "$C/.codex/session_index.jsonl"; grep -F ${q(id)} "$P/.codex/session_index.jsonl" 2>/dev/null | ` +
        `while IFS= read -r l; do grep -qxF -- "$l" "$C/.codex/session_index.jsonl" || printf '%s\\n' "$l" >> "$C/.codex/session_index.jsonl"; done; fi`,
    );
  }
  lines.push(`printf '%s moved %s\\n' ${CONVERSATION_LINE} "$moved"`);
  return lines.join("\n");
};

/** The links and the neutral seed of a conversation home, made as its sender inside `N`. */
const seedAsSender = (input: {
  readonly harness: ConversationHarness;
  readonly staged: string;
  readonly conversation: string;
  readonly senderHome: string;
  readonly model: string | null;
}): string => {
  const q = shellQuote;
  const seed: Readonly<Record<string, string>> =
    input.harness === "claude"
      ? claudeNeutralSeed()
      : {
          ".codex/config.toml": codexNeutralConfig({
            senderHome: input.senderHome,
            model: input.model,
          }),
        };
  const links = CONVERSATION_LINKS[input.harness];
  return [
    `set -e`,
    `N=${q(input.staged)}; C=${q(input.conversation)}`,
    `fail() { printf 'mend: %s\\n' "$1" >&2; exit 1; }`,
    `[ -L "$N" ] && fail "unexpected link: $N"`,
    `[ -L "$C" ] && fail "unexpected link: $C"`,
    `mkdir -p "$N/${input.harness === "claude" ? ".claude" : ".codex"}"`,
    ...links.map((link) =>
      link.kind === "directory"
        ? `mkdir -p "$C/${link.path}" && ln -s "$C/${link.path}" "$N/${link.path}"`
        : `mkdir -p "$(dirname "$C/${link.path}")" && { [ -e "$C/${link.path}" ] || : > "$C/${link.path}"; } && ln -s "$C/${link.path}" "$N/${link.path}"`,
    ),
    ...Object.entries(seed).map(
      ([relative, text]) =>
        `printf '%s' ${q(text)} > "$N/${relative}" && chmod 0600 "$N/${relative}"`,
    ),
  ].join("\n");
};

/**
 * The shell that finds the processes of a conversation's old agent: every process carrying its
 * marker (`MEND_CONVERSATION=<session id>`, inherited by every child, Codex's plugin and git
 * children included), and every process whose working directory or an open file is under `H`
 * (a child that cleared its environment). Prints their pids, one per line.
 */
const leftoverFunction = (procRoot: string): string =>
  `PR=${shellQuote(procRoot)}; ` +
  `leftover() { { grep -lsxz -- "${CONVERSATION_MARKER}=$sid" "$PR"/[0-9]*/environ; ` +
  `find "$PR"/[0-9]*/cwd "$PR"/[0-9]*/fd -maxdepth 1 -lname "$H/*"; } 2>/dev/null | ` +
  `sed -n "s#^$PR/\\([0-9]*\\)/.*#\\1#p" | grep -vx -- "$$" | sort -u; }`;

/**
 * The staging of the next agent process of a once-shared session (decision 6), as root, run beside
 * the old process's stop:
 *
 * 1. the move into `C` as the owner, the first time (`moveIntoConversationAsOwner`);
 * 2. `H.next` made new (a stale one from a hand-over that did not finish removed first), owned by
 *    the sender, 0700, so the login Core writes there comes out as theirs, then the links into `C`
 *    and the neutral seed written as the sender;
 * 3. the transcript a resume continues, found in `C` and printed as its path under `H`
 *    (`mend-conv resume <path>`), or `mend-conv missing` when the conversation has a provider id
 *    and `C` holds nothing for it: the turn fails, nothing is started on another conversation;
 * 4. the old process group: waited for until no process carries the marker or works under `H`
 *    (`mend-conv empty`); whatever an exited agent left running after the wait (at most
 *    `waitTenths`) is ended, and said (`mend-conv ended <n>`), so nothing writes into the old `H`.
 *
 * Nothing here touches `H` itself: a live process's directory is never written into.
 */
export const stageConversationHomeScript = (input: {
  readonly sessionId: string;
  readonly harness: ConversationHarness;
  readonly owner: LinuxIdentity;
  readonly sender: LinuxIdentity;
  readonly providerSessionId: string | null;
  readonly model: string | null;
  /** The move into `C` runs (shared control was turned on and it has not moved yet). */
  readonly move: boolean;
  readonly places: ConversationPlaces;
  /** The sender's passwd home; `/home/<name>` unless a test names another. */
  readonly senderHome?: string;
}): string => {
  assertScriptSafe(input.owner);
  assertScriptSafe(input.sender);
  const q = shellQuote;
  const sid = safeSessionId(input.sessionId);
  const root = input.places.homesRoot ?? CONVERSATION_HOMES;
  const home = conversationHomeOf(sid, root);
  const staged = stagedHomeOf(sid, root);
  const conversation = conversationDirOf(input.places.harnessHome, input.owner.accountId, sid);
  const saved = savedDirOf(input.places.harnessHome, input.owner.accountId);
  const id = input.providerSessionId === null ? null : safeProviderId(input.providerSessionId);
  const senderHome = input.senderHome ?? linuxHomeOf(input.sender);
  const tenths = input.places.waitTenths ?? 100;
  const resumeFind =
    id === null
      ? `:`
      : input.harness === "claude"
        ? `r=$(ls -1 "$C"/.claude/projects/*/${id}.jsonl 2>/dev/null | head -n 1); ` +
          `if [ -n "$r" ]; then printf '%s resume %s\\n' ${CONVERSATION_LINE} "$H/\${r#"$C/"}"; else printf '%s missing\\n' ${CONVERSATION_LINE}; fi`
        : `r=$(find "$C/.codex/sessions" "$C/.codex/archived_sessions" -type f -name 'rollout-*-${id}.jsonl' 2>/dev/null | head -n 1); ` +
          `if [ -n "$r" ]; then printf '%s resume %s\\n' ${CONVERSATION_LINE} "$H/\${r#"$C/"}"; else printf '%s missing\\n' ${CONVERSATION_LINE}; fi`;
  return [
    `set -e`,
    `root=0; [ "$(id -u)" = 0 ] && root=1`,
    `sid=${q(sid)}; H=${q(home)}; N=${q(staged)}; C=${q(conversation)}`,
    `fail() { printf 'mend: %s\\n' "$1" >&2; exit 1; }`,
    `mkdir -p ${q(root)}`,
    `[ -L ${q(root)} ] && fail "unexpected link: ${root}"`,
    `[ "$root" = 1 ] && chmod 0711 ${q(root)} || true`,
    ...(input.move
      ? [
          asPerson(
            input.owner,
            moveIntoConversationAsOwner({
              harness: input.harness,
              saved,
              conversation,
              providerSessionId: id,
            }),
          ),
        ]
      : [`[ -d "$C" ] || fail "this conversation has not moved into its shared directory"`]),
    // A staging left by a hand-over that did not finish: removed, never adopted.
    `if [ -e "$N" ] || [ -L "$N" ]; then mv -T -- "$N" "$N.mend-stale-$$" && rm -rf -- "$N.mend-stale-$$"; fi`,
    `mkdir -m 0700 "$N"`,
    `[ "$root" = 1 ] && chown ${input.sender.uid}:${MEND_GROUP.gid} "$N" || true`,
    asPerson(
      input.sender,
      seedAsSender({
        harness: input.harness,
        staged,
        conversation,
        senderHome,
        model: input.model,
      }),
    ),
    resumeFind,
    leftoverFunction(input.places.procRoot ?? "/proc"),
    `i=0; while [ "$i" -lt ${tenths} ] && [ -n "$(leftover)" ]; do sleep 0.1; i=$((i + 1)); done`,
    `left=$(leftover)`,
    `if [ -n "$left" ]; then n=$(printf '%s\\n' "$left" | wc -l); kill -TERM $left 2>/dev/null || true; ` +
      `j=0; while [ "$j" -lt 10 ] && [ -n "$(leftover)" ]; do sleep 0.1; j=$((j + 1)); done; ` +
      `left=$(leftover); [ -n "$left" ] && kill -KILL $left 2>/dev/null || true; ` +
      `printf '%s ended %s\\n' ${CONVERSATION_LINE} "$(printf '%s' "$n" | tr -d ' ')"; ` +
      // Looked at once more after the kill: only a group seen empty is said to be.
      `j=0; while [ "$j" -lt 10 ] && [ -n "$(leftover)" ]; do sleep 0.1; j=$((j + 1)); done; fi`,
    `if [ -n "$(leftover)" ]; then printf '%s busy\\n' ${CONVERSATION_LINE}; else printf '%s empty\\n' ${CONVERSATION_LINE}; fi`,
  ].join("\n");
};

/**
 * The exchange of `H` and `H.next` (decision 6), as root, once the old process group is empty and
 * `H`'s login is released: one `renameat2(RENAME_EXCHANGE)` where the image offers it (`mv
 * --exchange`, util-linux `exch`, or Python's `ctypes`), else two renames, which is the same
 * thing while nothing runs in either directory (the old process group is empty, and the new
 * process starts after this). The first home of a session is a plain rename. The old directory is
 * renamed out of the way and removed in the background; then a `chmod -R g+rwX`, as the owner with
 * only `CAP_FOWNER`, from inside
 * `C`, reached with every link resolved and checked, restores the group access a harness's 0600
 * files masked (Claude creates its transcript 0600). Prints
 * `mend-conv exchanged renameat2|renames|first`.
 */
export const exchangeConversationHomeScript = (input: {
  readonly sessionId: string;
  readonly owner: LinuxIdentity;
  readonly places: ConversationPlaces;
}): string => {
  assertScriptSafe(input.owner);
  const q = shellQuote;
  const sid = safeSessionId(input.sessionId);
  const root = input.places.homesRoot ?? CONVERSATION_HOMES;
  const home = conversationHomeOf(sid, root);
  const staged = stagedHomeOf(sid, root);
  const conversation = conversationDirOf(input.places.harnessHome, input.owner.accountId, sid);
  const renameat2 =
    `import ctypes, sys\n` +
    `libc = ctypes.CDLL(None, use_errno=True)\n` +
    `f = getattr(libc, "renameat2", None)\n` +
    `sys.exit(3 if f is None else (0 if f(-100, sys.argv[1].encode(), -100, sys.argv[2].encode(), 2) == 0 else 1))`;
  return [
    `set -e`,
    `H=${q(home)}; N=${q(staged)}; C=${q(conversation)}`,
    `fail() { printf 'mend: %s\\n' "$1" >&2; exit 1; }`,
    `[ -d "$N" ] && [ ! -L "$N" ] || fail "nothing is staged for this conversation"`,
    `[ -L "$H" ] && fail "unexpected link: $H"`,
    // Where `C` must physically be: checked before the exchange, and again from inside it.
    `B=$(cd -P -- ${q(input.places.harnessHome)} && pwd -P) || fail "the harness home is not there"`,
    `want="$B/${PEOPLE_DIR}/${input.owner.accountId}/conversations/${sid}"`,
    `[ -L "$C" ] && fail "unexpected link: $C"`,
    `( cd -P -- "$C" && [ "$(pwd -P)" = "$want" ] ) || fail "the conversation's directory is not where it should be: $C"`,
    `how=first`,
    `if [ -e "$H" ]; then ` +
      `if mv --help 2>&1 | grep -q -- '--exchange' && mv --exchange -T -- "$N" "$H" 2>/dev/null; then how=renameat2; ` +
      `elif command -v exch >/dev/null 2>&1 && exch -- "$N" "$H" 2>/dev/null; then how=renameat2; ` +
      `elif command -v python3 >/dev/null 2>&1 && python3 -c ${q(renameat2)} "$N" "$H" 2>/dev/null; then how=renameat2; ` +
      `else mv -T -- "$H" "$H.mend-old-$$" && mv -T -- "$N" "$H" && mv -T -- "$H.mend-old-$$" "$N"; how=renames; fi; ` +
      // The old directory goes in the background, under a name of its own so the next staging
      // never meets it.
      `old="$N.mend-gone-$$"; mv -T -- "$N" "$old" && { (rm -rf -- "$old" >/dev/null 2>&1 &) ; }; ` +
      `else mv -T -- "$N" "$H"; fi`,
    // Group access a harness's own 0600 files masked. `C` and its parents are the owner's, so
    // root never takes their word for where they lead: from inside `C`, reached with every link
    // resolved, its physical path must be the one expected, and the walk starts at `.`, so a link
    // put in `C`'s place, or anywhere above it, reaches nothing (review of mend#572, P2-A).
    // The walk runs as the owner with only `CAP_FOWNER`, never as root: any person here may swap
    // an entry of `C` for a link while it runs, and an older `chmod -R` (coreutils 9.1) can then
    // follow it; as the owner, a link into another person's 0700 home reaches nothing (review 2 of
    // mend#572, P3-A). Every person's primary group is `mend`, so new entries take the group
    // without setgid.
    `root=0; [ "$(id -u)" = 0 ] && root=1`,
    `( cd -P -- "$C" && [ "$(pwd -P)" = "$want" ] && ` +
      `if [ "$root" = 1 ]; then setpriv --reuid=${input.owner.uid} --regid=${MEND_GROUP.gid} --clear-groups --inh-caps=+fowner --ambient-caps=+fowner -- chmod -R g+rwX .; ` +
      `else chmod -R g+rwX .; fi ) || fail "the conversation's directory is not where it should be: $C"`,
    `printf '%s exchanged %s\\n' ${CONVERSATION_LINE} "$how"`,
  ].join("\n");
};

/** What the staging and the exchange said, read from stdout. */
export interface ConversationReport {
  /** How many entries the move into `C` moved; null when no move ran. */
  readonly moved: number | null;
  /** Personal copies left because `C` already held one. */
  readonly kept: ReadonlyArray<string>;
  /** The transcript a resume continues, under `H`. */
  readonly resume: string | null;
  /** The conversation has a provider id and `C` holds nothing for it. */
  readonly missing: boolean;
  /** The old process group is empty. */
  readonly empty: boolean;
  /** How many processes an exited agent left running were ended after the wait. */
  readonly ended: number;
  /** How the exchange ran; null when it did not. */
  readonly exchanged: "renameat2" | "renames" | "first" | null;
}

export const parseConversationReport = (stdout: string): ConversationReport => {
  let moved: number | null = null;
  const kept: Array<string> = [];
  let resume: string | null = null;
  let missing = false;
  let empty = false;
  let ended = 0;
  let exchanged: ConversationReport["exchanged"] = null;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${CONVERSATION_LINE} `)) continue;
    const rest = line.slice(CONVERSATION_LINE.length + 1).trim();
    if (rest.startsWith("moved ")) moved = Number(rest.slice("moved ".length)) || 0;
    else if (rest.startsWith("kept ")) kept.push(rest.slice("kept ".length));
    else if (rest.startsWith("resume ")) resume = rest.slice("resume ".length);
    else if (rest === "missing") missing = true;
    else if (rest === "empty") empty = true;
    else if (rest.startsWith("ended ")) ended = Number(rest.slice("ended ".length)) || 0;
    else if (rest.startsWith("exchanged ")) {
      const how = rest.slice("exchanged ".length);
      exchanged = how === "renameat2" || how === "renames" || how === "first" ? how : null;
    }
  }
  return { moved, kept, resume, missing, empty, ended, exchanged };
};

// ─── a turn that failed for the conversation ─────────────────────────────────

/**
 * Whether a failed turn's words are a provider refusing opaque, account-bound items made on another
 * account (decision 6): Codex's `invalid_encrypted_content` on a reasoning or remote compaction
 * item, or Anthropic refusing a thinking block's signature. The owner has seen providers accept a
 * conversation replayed under another account; this is the case where one does not.
 */
export const isForeignReasoningRefusal = (error: string | null): boolean =>
  error !== null &&
  /invalid_encrypted_content|encrypted[_ ]content[^.]{0,80}(?:could not|cannot|failed to) be (?:decrypted|verified|parsed)|invalid[^.]{0,40}signature[^.]{0,40}thinking|thinking[^.]{0,60}signature[^.]{0,40}(?:invalid|not valid|does not match|mismatch)/i.test(
    error,
  );

/**
 * The line such a turn fails with: nothing is retried and the conversation is untouched, so the
 * person whose account made the reasoning can continue it.
 */
export const foreignReasoningLine = (input: {
  readonly harness: ConversationHarness;
  readonly sender: string;
  readonly previous: string;
}): string =>
  `${input.sender}'s turn failed: ${input.harness === "codex" ? "OpenAI" : "Anthropic"} refused reasoning made on ${input.previous}'s account. ${input.previous} can continue the conversation.`;
