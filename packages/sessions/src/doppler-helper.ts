/** Dependency-free workspace command. Tokens stay in memory and the person's uncaptured home. */
export const DOPPLER_HELPER_SCRIPT = String.raw`
const dopplerCommand = async (verb, rest) => {
  const cp = require("node:child_process");
  const path = require("node:path");
  const home = require("node:os").homedir();
  const dir = path.join(home, ".doppler");
  const file = path.join(dir, ".doppler.yaml");
  const digest = (scoped) => require("node:crypto").createHash("sha256").update(JSON.stringify(scoped)).digest("hex");
  const all = () => {
    const answer = cp.spawnSync("doppler", ["configure", "--all", "--json", "--no-check-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (answer.status === 0) {
      try { return JSON.parse(answer.stdout); } catch { throw new Error("Doppler's local config could not be read."); }
    }
    try { const parsed = JSON.parse(fs.readFileSync(file, "utf8")); if (parsed.scoped) return parsed.scoped; } catch {}
    throw new Error("No local Doppler token found. Run doppler login first.");
  };
  const entriesOf = (scoped) => Object.entries(scoped).sort(([a], [b]) => b.length - a.length);
  const at = (scoped, directory, key) => entriesOf(scoped).find(([scope, options]) => options && typeof options[key] === "string" && (directory === scope || directory.startsWith(scope.endsWith("/") ? scope : scope + "/")))?.[1][key];
  const localToken = (scoped) => {
    const token = at(scoped, process.cwd(), "token");
    if (!token || token.startsWith("secret-") || /\s/.test(token)) throw new Error("No local Doppler token found. Run doppler login first.");
    return token;
  };
  const ownFile = (action) => {
    if (fs.realpathSync(home) === "/workspace" || fs.realpathSync(home).startsWith("/workspace/") || fs.lstatSync(home).isSymbolicLink()) throw new Error("Doppler home must be outside the captured workspace.");
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const target = "/proc/self/fd/" + fd + "/.doppler.yaml";
    try {
      const opened = fs.fstatSync(fd), current = fs.lstatSync(dir);
      if (opened.ino !== current.ino || opened.dev !== current.dev || current.isSymbolicLink()) throw new Error("Doppler directory changed.");
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Doppler config is a symlink.");
      action(target);
    } finally { fs.closeSync(fd); }
  };
  const write = (token, selection) => ownFile((target) => {
    const scoped = { "/": { token }, "/workspace/repo": { "enclave.project": selection.dopplerProject, "enclave.config": selection.config } };
    const contents = JSON.stringify({ scoped, "mend-delivery": digest(scoped) }, null, 2) + "\n";
    const staged = target + ".mend-" + require("node:crypto").randomUUID();
    try { fs.writeFileSync(staged, contents, { mode: 0o600, flag: "wx" }); fs.renameSync(staged, target); }
    finally { try { fs.unlinkSync(staged); } catch {} }
  });
  const ask = (body) => request("POST", "/doppler", body);
  if (verb === "connect") {
    const scoped = all();
    await ask({ action: "connect", token: localToken(scoped) });
    const { projects } = await ask({ action: "projects" });
    const normalize = (remote) => remote.replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://").replace(/\.git\/?$/, "").replace(/\/$/, "");
    const mapped = new Set();
    for (const [directory] of entriesOf(scoped).reverse()) {
      const dopplerProject = at(scoped, directory, "enclave.project"), config = at(scoped, directory, "enclave.config");
      if (!dopplerProject || !config) continue;
      const git = cp.spawnSync("git", ["-C", directory, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (git.status !== 0) continue;
      const matches = projects.filter((p) => p.originUrl && normalize(p.originUrl) === normalize(git.stdout.trim()));
      if (matches.length !== 1 || mapped.has(matches[0].id)) continue;
      await ask({ action: "use", project: matches[0].id, dopplerProject, config });
      mapped.add(matches[0].id);
      console.log(matches[0].name + " · " + dopplerProject + "/" + config);
    }
    console.log("Doppler connected · " + mapped.size + " project mappings imported");
    return;
  }
  if (verb === "use") {
    const flag = rest.indexOf("--project");
    const project = flag === -1 ? undefined : rest[flag + 1];
    const positional = rest.filter((_, i) => flag === -1 || (i !== flag && i !== flag + 1));
    if (positional.length !== 2 || (flag !== -1 && !project)) throw new Error("usage: mend doppler use <doppler-project> <config> [--project <mend-project>]");
    const token = localToken(all());
    const selected = await ask({ action: "use", project, dopplerProject: positional[0], config: positional[1] });
    if (selected.current) write(token, selected);
    console.log(selected.projectName + " · Doppler " + selected.dopplerProject + "/" + selected.config + (selected.current ? " · local config updated" : ""));
    return;
  }
  if (verb === "disconnect") {
    await ask({ action: "disconnect" });
    if (fs.existsSync(file)) ownFile((target) => {
      let config; try { config = JSON.parse(fs.readFileSync(target, "utf8")); } catch { return; }
      if (config["mend-delivery"] === digest(config.scoped)) fs.unlinkSync(target);
    });
    console.log("Doppler disconnected · token and mappings removed from Mend");
    return;
  }
  if (verb !== undefined && verb !== "status") throw new Error("usage: mend doppler connect|use|status|disconnect");
  const status = await ask({ action: "status" });
  console.log(status.connected ? "Doppler connected" + (status.updatedAt ? " · updated " + status.updatedAt : "") : "Doppler not connected · mend doppler connect after doppler login");
  for (const mapping of status.mappings) console.log(mapping.projectName + " · " + mapping.dopplerProject + "/" + mapping.config);
  const binary = cp.spawnSync("doppler", ["--version"], { stdio: "ignore" });
  if (binary.error?.code === "ENOENT") console.log("Doppler CLI isn't installed in this workspace.");
};
`;
