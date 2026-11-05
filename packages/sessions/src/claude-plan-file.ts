/** Executor paths owned by the existing launch, also reconstructed for surviving pipes. */
export interface ClaudePlanFileScope {
  readonly savedClaudeDirectory: string;
  readonly providerSessionId: string;
  readonly cwd: string;
  /** A neutral conversation uses CLAUDE_CONFIG_DIR while keeping its sender's personal HOME. */
  readonly configDirectory?: string | undefined;
}

// Read native metadata, not the model's proposed path. get_plan omits its path before the
// first Write. Claude records this attachment for that Write, but its flush can lag the callback.
// Wait briefly for that flush, without granting anything when the metadata stays unavailable. The only
// alias admitted here is the plans directory Mend linked to this launch's saved state.
// Leaf links/hardlinks, changed directory targets and unreadable metadata fail closed.
const CHECK_PLAN_FILE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
async function check() {
  const [scopeJson, requested, blocked] = process.argv.slice(1);
  const scope = JSON.parse(scopeJson);
  const config = scope.configDirectory || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, ".claude");
  const saved = scope.savedClaudeDirectory;
  const clean = p => typeof p === "string" && path.isAbsolute(p) && path.normalize(p) === p && !p.includes("\\") && !/[\x00-\x1f\x7f]/.test(p);
  if (![config, saved, requested, blocked, scope.cwd].every(clean)) return false;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(scope.providerSessionId)) return false;
  const name = path.basename(requested);
  if (!/^[A-Za-z0-9_-]+\.md$/.test(name)) return false;
  if (requested !== path.join(config, "plans", name) || blocked !== path.join(saved, "plans", name) || requested === blocked) return false;
  if (fs.realpathSync(saved) !== saved || fs.realpathSync(path.dirname(requested)) !== path.join(saved, "plans")) return false;
  if (fs.realpathSync(path.join(saved, "plans")) !== path.join(saved, "plans")) return false;
  try {
    const leaf = fs.lstatSync(blocked);
    if (!leaf.isFile() || leaf.nlink !== 1) return false;
  } catch (error) { if (error.code !== "ENOENT") return false; }
  const projects = path.join(saved, "projects");
  const cwd = fs.realpathSync(scope.cwd);
  if (!clean(cwd)) return false;
  const project = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  try { if (fs.realpathSync(project) !== project) return false; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const transcript = path.join(project, scope.providerSessionId + ".jsonl");
  let fd;
  try { fd = fs.openSync(transcript, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) { fs.closeSync(fd); return false; }
  let plan = null;
  const lines = readline.createInterface({ input: fs.createReadStream(transcript, { fd, autoClose: true }), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry === null || typeof entry !== "object" || entry.sessionId !== scope.providerSessionId || entry.cwd !== cwd || entry.isSidechain !== false || entry.type !== "attachment") continue;
    const attachment = entry.attachment;
    if (attachment === null || typeof attachment !== "object") continue;
    if (attachment.type === "plan_mode_exit") plan = null;
    if (attachment.type === "plan_mode" && attachment.isSubAgent === false) plan = attachment.planFilePath;
  }
  return plan === null ? null : plan === requested;
}
async function awaitMetadata() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await check();
    if (result !== null) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}
awaitMetadata().then(value => process.stdout.write(String(value)), () => process.stdout.write("false"));
`;

/** Read only this executor's native plan metadata and verify Mend's exact directory alias. */
export const claudePlanFileArgv = (
  scope: ClaudePlanFileScope,
  filePath: string,
  blockedPath: string,
): ReadonlyArray<string> => [
  "node",
  "-e",
  CHECK_PLAN_FILE,
  JSON.stringify(scope),
  filePath,
  blockedPath,
];
