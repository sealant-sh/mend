import { OPENCODE_DEFAULT_MODEL } from "@mend/domain/workbench";

import { PI_PROFILE_PROGRAM } from "./pi-profile.ts";

/**
 * The shell prefixes that pre-answer a harness's first-run questions before Mend execs its real
 * argv (`sh -c <seed> sh <argv…>`). They run at every launch, over whatever the harness home holds
 * then: a restored capture, the user's own settings, the harness's own state files.
 *
 * Interactive Claude Code ignores the platform's env-injected credential during onboarding:
 * `claude -p` honors `CLAUDE_CODE_OAUTH_TOKEN`, but the TUI's first-run flow still demands a login
 * until `~/.claude.json` marks onboarding complete and `~/.claude/.credentials.json` exists. The
 * seed writes the credential only where none exists, so a real login is never clobbered (filed as
 * platform feedback: the claude injection should be file-kind, like codex's `auth.json`).
 *
 * `~/.claude.json` and `~/.claude/settings.json` are MERGED, not guarded by existence: a restored
 * session brings back claude's own rewritten `.claude.json` (which knows nothing of these flags),
 * so the seed re-asserts them at every launch and keeps everything else. Pre-answered: onboarding,
 * bypass acceptance, and the /workspace/repo trust (the user made the trust decision when they
 * adopted the repo, and bypass is Mend's stance: the workspace is the sandbox).
 *
 * Review 2026-09-28 (17), sweep: both files are the user's and claude's as much as Mend's, and the
 * seed used to read "unparseable" as "empty" and write its three keys over the whole file. Now a
 * file that is absent starts empty; a file that cannot be read, is not a JSON object, or is a
 * symlink to nothing is left exactly as it is. A file that already says what the seed would say
 * is not written at all. A write goes to a temporary file beside the target (a symlink's target)
 * and is renamed over it, keeping the mode. The temporary is created exclusively; a name that is
 * already taken is someone else's file and is left alone, and another name is tried (review
 * 2026-09-28 (18)).
 */

const CLAUDE_SEED_PROGRAM = [
  `const fs=require("fs"),os=require("os"),path=require("path"),crypto=require("crypto"),h=os.homedir(),t=process.env.CLAUDE_CODE_OAUTH_TOKEN;`,
  `fs.mkdirSync(h+"/.claude",{recursive:true});`,
  `if(t){try{fs.writeFileSync(h+"/.claude/.credentials.json",JSON.stringify({claudeAiOauth:{accessToken:t,refreshToken:"",expiresAt:9999999999999,scopes:["user:inference","user:profile"],subscriptionType:"max"}}),{mode:0o600,flag:"wx"})}catch{}}`,
  // Absent reads as {}; anything else that is not a JSON object is null: leave the file alone.
  `function read(p){let raw;try{raw=fs.readFileSync(p,"utf8")}catch(e){if(e.code!=="ENOENT")return null;try{fs.lstatSync(p);return null}catch{return {}}}`,
  `try{const v=JSON.parse(raw);return v!==null&&typeof v==="object"&&!Array.isArray(v)?v:null}catch{return null}}`,
  `function put(p,text){let real=p,mode=0o644;try{real=fs.realpathSync(p);mode=fs.statSync(real).mode&0o7777}catch{}`,
  // The temporary is this run's only once its exclusive create succeeded; a name that is taken
  // is someone else's file and is never removed: the next try takes a random suffix.
  `const base=path.join(path.dirname(real),"."+path.basename(real)+".mend-seed-"+process.pid);let tmp=null,fd=null;`,
  `for(let i=0;fd===null&&i<17;i++){const n=i===0?base:base+"-"+crypto.randomBytes(6).toString("hex");try{fd=fs.openSync(n,"wx",mode);tmp=n}catch(e){if(e.code!=="EEXIST")return}}`,
  `if(fd===null)return;try{try{fs.writeFileSync(fd,text);fs.fchmodSync(fd,mode)}finally{fs.closeSync(fd)}fs.renameSync(tmp,real)}catch{try{fs.unlinkSync(tmp)}catch{}}}`,
  `function merge(p,f){const v=read(p);if(v===null)return;const before=JSON.stringify(v);f(v);`,
  `if(JSON.stringify(v)===before&&fs.existsSync(p))return;put(p,JSON.stringify(v,null,2))}`,
  `merge(h+"/.claude.json",c=>{c.hasCompletedOnboarding=true;c.bypassPermissionsModeAccepted=true;`,
  `c.projects=c.projects&&typeof c.projects==="object"?c.projects:{};`,
  `c.projects["/workspace/repo"]=Object.assign({},c.projects["/workspace/repo"],{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true})});`,
  // The bypass-acceptance dialog is actually gated on settings.json (verified: accepting it
  // writes exactly this key), not .claude.json. The workspace image never sees the operator's
  // own ~/.claude settings, so a fresh session silently falls back to the CLI's default model:
  // default-if-absent only, so a restored session's own choice (or a mid-session /model) stays.
  // The default is the `fable` alias, which Claude Code resolves to the latest Fable; a session
  // still holding Mend's own earlier default (`claude-fable-5`) moves to it (2026-10-01).
  `merge(h+"/.claude/settings.json",s=>{s.skipDangerousModePermissionPrompt=true;if(!s.model||s.model==="claude-fable-5")s.model="fable"});`,
].join("");

/**
 * Claude's seed. The workspace IS the sandbox: Claude Code refuses bypass-permissions as root
 * unless the environment says so, and it is telling the truth.
 */
export const CLAUDE_ONBOARDING_SEED = `node -e '${CLAUDE_SEED_PROGRAM}' 2>/dev/null; export IS_SANDBOX=1; exec "$@"`;

/**
 * Codex's per-project trust prompt, pre-answered the same way: the user made the trust decision
 * when they adopted the repo. Appended only when the file names no such project; the table starts
 * on a line of its own even when the file does not end in a newline, so the user's last line and
 * the new table never run together.
 */
export const CODEX_TRUST_SEED =
  `mkdir -p "$HOME/.codex"; ` +
  `grep -q 'workspace/repo' "$HOME/.codex/config.toml" 2>/dev/null || ` +
  `printf '\\n[projects."/workspace/repo"]\\ntrust_level = "trusted"\\n' >> "$HOME/.codex/config.toml"; ` +
  `exec "$@"`;

/**
 * The refresh token every copy of a Codex login carries (Core's `CODEX_COPY_REFRESH_TOKEN`, ADR
 * 0008): no provider accepts it, so no copy can rotate the login the platform refreshes.
 */
export const COPY_REFRESH_TOKEN = "sealant-copy-cannot-refresh";

/**
 * The ChatGPT login pi and opencode run on: the Codex login the platform injected
 * (`$HOME/.codex/auth.json`, already a copy that cannot refresh), written into the tool's own
 * `auth.json` in its own shape — `{type: "oauth", access, refresh, expires, accountId}` under
 * `openai-codex` (pi) or `openai` (opencode). Both read it as their ChatGPT subscription login
 * (verified 2026-10-01: pi `auth check` reads it `ready`, opencode lists it as OpenAI oauth).
 *
 * The entry is written only when it is absent or is an earlier copy (its refresh token is the
 * placeholder), so a login the user made inside the session is never replaced. The expiry is the
 * access token's own; a session that outlives it gets the platform's newer copy at its next launch
 * or resume. pi's default provider becomes `openai-codex` only when the user has chosen none.
 *
 * `argv[1]` is the auth file, `argv[2]` the entry's key, `argv[3]` pi's settings file or "".
 */
const CHATGPT_LOGIN_PROGRAM = [
  `const fs=require("fs"),path=require("path"),[file,key,settings]=process.argv.slice(1);`,
  `let codex;try{codex=JSON.parse(fs.readFileSync(require("os").homedir()+"/.codex/auth.json","utf8"))}catch{process.exit(0)}`,
  `const t=codex&&codex.tokens;if(!t||typeof t.access_token!=="string"||typeof t.account_id!=="string")process.exit(0);`,
  `let exp;try{exp=JSON.parse(Buffer.from(t.access_token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"),"base64").toString()).exp}catch{}`,
  `if(typeof exp!=="number")process.exit(0);`,
  `function read(p){try{const v=JSON.parse(fs.readFileSync(p,"utf8"));return v!==null&&typeof v==="object"&&!Array.isArray(v)?v:null}catch(e){return e.code==="ENOENT"?{}:null}}`,
  `function put(p,v){fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+".mend-seed-"+process.pid;fs.writeFileSync(tmp,JSON.stringify(v,null,2),{mode:0o600});fs.renameSync(tmp,p)}`,
  `const auth=read(file);if(auth===null)process.exit(0);`,
  `const prior=auth[key];if(prior&&typeof prior==="object"&&prior.refresh!==${JSON.stringify(COPY_REFRESH_TOKEN)})process.exit(0);`,
  `auth[key]={type:"oauth",access:t.access_token,refresh:${JSON.stringify(COPY_REFRESH_TOKEN)},expires:exp*1000,accountId:t.account_id};put(file,auth);`,
  `if(settings){const s=read(settings);if(s!==null&&!s.defaultProvider){s.defaultProvider=key;put(settings,s)}}`,
].join("");

/**
 * The model opencode opens on when nothing chose one (`OPENCODE_DEFAULT_MODEL`), written as its
 * last used model: `model.json` in its state directory, `{recent: [{providerID, modelID}], …}`,
 * the list opencode reads after `--model` and the `model` of its config and before falling back
 * to the first provider it sees (opencode 1.18.34, `tui/src/context/local.tsx`). That fallback is
 * GitHub Copilot in a workspace, from the git token, and Copilot refuses it.
 *
 * Written only when opencode holds an `openai` login (the one `CHATGPT_LOGIN_PROGRAM` wrote, or the
 * user's own) and the file names no recent model: a model picked in opencode stays, and every
 * other key in the file is kept. A file that is not a JSON object is left alone.
 *
 * `argv[1]` is opencode's `auth.json`, `argv[2]` its `model.json`, `argv[3]` the model.
 */
const OPENCODE_MODEL_PROGRAM = [
  `const fs=require("fs"),path=require("path"),[authFile,file,model]=process.argv.slice(1);`,
  `function read(p){try{const v=JSON.parse(fs.readFileSync(p,"utf8"));return v!==null&&typeof v==="object"&&!Array.isArray(v)?v:null}catch(e){return e.code==="ENOENT"?{}:null}}`,
  `const auth=read(authFile);if(!auth||!auth.openai)process.exit(0);`,
  `const state=read(file);if(state===null||(Array.isArray(state.recent)&&state.recent.length>0))process.exit(0);`,
  `const slash=model.indexOf("/");if(slash<1)process.exit(0);`,
  `state.recent=[{providerID:model.slice(0,slash),modelID:model.slice(slash+1)}];`,
  `fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+".mend-seed-"+process.pid;`,
  `fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,file);`,
].join("");

/**
 * Where opencode keeps the logins of the MCP servers it connects to (`mcp-auth.json`, tokens and
 * client secrets), kept out of saved state in capture mode: its data directory is the harness home
 * a capture saves and the next session in the worktree, anyone's, materialises. Until sealantd
 * leaves the file out of captures, as it does opencode's `auth.json` (sealantd#136,
 * PLATFORM-FEEDBACK.md), the file there is a link to `~/.mend/opencode/mcp-auth.json` in the
 * executor's own home, which opencode writes through (it writes the file in place,
 * `core/src/fs-util.ts` `writeJson`). A plain file found there came from a capture, maybe another
 * person's, and is removed unread (as capture mode's relocation also does before any launch,
 * `CAPTURED_LOGIN_FILES`); a link that leads anywhere else is replaced. A home where the link
 * cannot be made stops the launch rather than let the logins be saved. Two launches into one
 * executor at once both end with the same link.
 *
 * Part of the seed only for a capture launch, which Mend knows (`withHarnessSetup`'s
 * `captured`): the executor's environment does not say, since sealantd consumes its capture
 * variables before any process starts. A co-located session's harness home is its own and leaves
 * the file out of what it saves, so the person's MCP logins stay there across relaunches.
 */
export const OPENCODE_MCP_AUTH_SEED =
  `d="\${XDG_DATA_HOME:-$HOME/.local/share}/opencode"; f="$d/mcp-auth.json"; k="$HOME/.mend/opencode"; ` +
  `if [ -e "$f" ] && [ ! -L "$f" ]; then rm -rf "$f"; fi; ` +
  `kp=$( (umask 077; mkdir -p "$k") 2>/dev/null && cd "$k" 2>/dev/null && pwd -P) || kp=""; ` +
  `case "$kp" in ""|/workspace|/workspace/*) rm -f "$f"; ` +
  `echo "mend: opencode's MCP logins cannot be kept out of saved state here; not starting opencode" >&2; exit 1;; esac; ` +
  `[ "$(readlink "$f" 2>/dev/null)" = "$kp/mcp-auth.json" ] || ` +
  `{ mkdir -p "$d" && { ln -sfn "$kp/mcp-auth.json" "$f" 2>/dev/null || [ "$(readlink "$f" 2>/dev/null)" = "$kp/mcp-auth.json" ]; }; } || ` +
  `{ echo "mend: opencode's MCP logins cannot be kept out of saved state here; not starting opencode" >&2; exit 1; }; `;

/** opencode's seed up to its MCP logins, which a capture launch adds (`OPENCODE_CAPTURED_SEED`). */
const OPENCODE_SEED_HEAD =
  `node -e '${CHATGPT_LOGIN_PROGRAM}' "\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json" openai "" 2>/dev/null; ` +
  `node -e '${OPENCODE_MODEL_PROGRAM}' "\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json" "\${XDG_STATE_HOME:-$HOME/.local/state}/opencode/model.json" '${OPENCODE_DEFAULT_MODEL}' 2>/dev/null; `;

/**
 * opencode's and pi's seeds: no first-run questions to answer (opencode's permissions ride the
 * launch's environment, pi's project trust its `--approve`). Each writes the ChatGPT login it runs
 * on (`CHATGPT_LOGIN_PROGRAM`) and turns off its own update check, which a workspace's image owns:
 * Core installs each harness at build time. opencode's then names the model it opens on when
 * nothing else does (`OPENCODE_MODEL_PROGRAM`), and in capture mode keeps its MCP logins out of
 * saved state (`OPENCODE_CAPTURED_SEED`). pi's first sets up the person's pi profile, when one
 * was delivered (`PI_PROFILE_PROGRAM`), so the login's default provider defers to theirs.
 */
export const OPENCODE_SEED = OPENCODE_SEED_HEAD + `export OPENCODE_DISABLE_AUTOUPDATE=1; exec "$@"`;
export const OPENCODE_CAPTURED_SEED =
  OPENCODE_SEED_HEAD + OPENCODE_MCP_AUTH_SEED + `export OPENCODE_DISABLE_AUTOUPDATE=1; exec "$@"`;
export const PI_SEED =
  `node -e '${PI_PROFILE_PROGRAM}' "\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; ` +
  `node -e '${CHATGPT_LOGIN_PROGRAM}' "\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json" openai-codex "\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json" 2>/dev/null; ` +
  `export PI_SKIP_VERSION_CHECK=1; exec "$@"`;

/**
 * Codex's memory, on for every Codex session Mend starts (docs/adr/0009, "Codex"): the feature is
 * off by default, and a session reads what Mend carried into its `.codex/memories` only with it
 * on. A launch that names the feature itself is left as it is.
 */
export const CODEX_MEMORY_FLAG = ["-c", "features.memories=true"] as const;

export const withCodexMemory = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [head, ...rest] = argv;
  if (head !== "codex" || argv.some((arg) => arg.startsWith("features.memories"))) return argv;
  return [head, ...CODEX_MEMORY_FLAG, ...rest];
};

/** What turns Codex's memory fully off: no summarising, and no thread created for it. */
export const CODEX_MEMORY_OFF = [
  "-c",
  "features.memories=false",
  "-c",
  "memories.generate_memories=false",
] as const;

/**
 * A Codex launch with its memory fully off, whatever it asked (docs/adr/0009, "Codex"): a join
 * into another person's home, or a launch where Mend could not take the other people's
 * conversations out of Codex's memory. Codex neither summarises (`features.memories`) nor creates
 * a thread any Codex will summarise later (`memories.generate_memories`: a new thread is created
 * with its memory disabled). A `--enable memories` in the launch would win over `-c`, so it is
 * dropped, and a `-c` that names either setting is turned off. Takes both shapes Mend launches:
 * `codex …`, and a prompt's `sh -c "… exec codex -c features.memories=true …"`.
 */
export const withCodexMemoryOff = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [head, ...rest] = argv;
  if (head === "codex") {
    const kept: Array<string> = [];
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index] ?? "";
      if (arg === "--enable" && rest[index + 1] === "memories") {
        index++;
        continue;
      }
      if (arg === "--enable=memories") continue;
      // A `-c` naming either setting goes with its value; Mend's own say comes first.
      if (
        arg === "-c" &&
        /^(features\.memories|memories\.generate_memories)(=|$)/.test(rest[index + 1] ?? "")
      ) {
        index++;
        continue;
      }
      kept.push(arg);
    }
    return [head, ...CODEX_MEMORY_OFF, ...kept];
  }
  const script = argv[2];
  if (head === "sh" && argv[1] === "-c" && script !== undefined) {
    return [
      head,
      "-c",
      script.replaceAll("-c features.memories=true", CODEX_MEMORY_OFF.join(" ")),
      ...argv.slice(3),
    ];
  }
  return argv;
};

/**
 * Codex's background server, never started by a Codex session Mend starts. Codex 0.160's TUI
 * starts a shared app-server daemon by default (`features.daemon_auto_start`), and the daemon first
 * copies Codex's own release into `.codex/packages/app-server-daemon/`: about 427 MB in the harness
 * home, which every capture then saves and every later executor of the worktree restores. Mend
 * runs one agent per process and has no use for the shared server.
 *
 * Today's launches stay off the daemon only by accident: Codex refuses the shared server when a
 * `-c` override names a setting it cannot forward, and `features.memories` is one. The flag makes
 * it explicit, on every path: the app-server, the terminal, a prompt, a resume, a handoff, a join
 * and a claimed standby all pass through `withHarnessSetup` or `promptArgv`. Observed 2026-10-05
 * with Codex 0.160.0: with only this flag, no daemon starts, nothing is copied, and a turn runs as
 * before; without any `-c`, the TUI copies 427 MB. A launch that names the setting itself, or
 * passes `--no-daemon`, is left as it is.
 */
export const CODEX_DAEMON_OFF = ["-c", "features.daemon_auto_start=false"] as const;

export const withoutCodexDaemon = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [head, ...rest] = argv;
  if (
    head !== "codex" ||
    argv.some(
      (arg) =>
        arg === "--no-daemon" ||
        arg === "daemon_auto_start" ||
        /^features\.daemon_auto_start(=|$)/.test(arg),
    )
  ) {
    return argv;
  }
  return [head, ...CODEX_DAEMON_OFF, ...rest];
};

/**
 * `argv` behind its harness's seed; a harness without one runs as it is. `captured`: a capture
 * launch, whose harness home the next session in the worktree materialises (opencode keeps its MCP
 * logins out of it then, `OPENCODE_CAPTURED_SEED`).
 */
export const withHarnessSetup = (
  harness: string,
  argv: ReadonlyArray<string>,
  options: { readonly captured?: boolean } = {},
): ReadonlyArray<string> => {
  if (harness === "claude") return ["sh", "-c", CLAUDE_ONBOARDING_SEED, "sh", ...argv];
  if (harness === "codex") {
    return ["sh", "-c", CODEX_TRUST_SEED, "sh", ...withoutCodexDaemon(withCodexMemory(argv))];
  }
  if (harness === "opencode") {
    const seed = options.captured === true ? OPENCODE_CAPTURED_SEED : OPENCODE_SEED;
    return ["sh", "-c", seed, "sh", ...argv];
  }
  if (harness === "pi") return ["sh", "-c", PI_SEED, "sh", ...argv];
  return argv;
};
