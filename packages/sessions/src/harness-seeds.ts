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
 * opencode's and pi's: no first-run questions to answer (opencode's permissions ride the launch's
 * environment, pi's project trust its `--approve`), only their own update checks, which a
 * workspace's image owns: Core installs each harness at build time.
 */
export const OPENCODE_SEED = `export OPENCODE_DISABLE_AUTOUPDATE=1; exec "$@"`;
export const PI_SEED = `export PI_SKIP_VERSION_CHECK=1; exec "$@"`;

/** `argv` behind its harness's seed; a harness without one runs as it is. */
export const withHarnessSetup = (
  harness: string,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (harness === "claude") return ["sh", "-c", CLAUDE_ONBOARDING_SEED, "sh", ...argv];
  if (harness === "codex") return ["sh", "-c", CODEX_TRUST_SEED, "sh", ...argv];
  if (harness === "opencode") return ["sh", "-c", OPENCODE_SEED, "sh", ...argv];
  if (harness === "pi") return ["sh", "-c", PI_SEED, "sh", ...argv];
  return argv;
};
