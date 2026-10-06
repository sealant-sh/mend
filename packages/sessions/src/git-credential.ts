/**
 * `mend-git-credential` (docs/adr/0016, decision 4): git's credential helper for
 * `https://github.com` in a person-layout executor, staged beside the `mend` helper at
 * `/run/mend/bin` and named in the system git config by the person layout's prepare. It answers
 * with the GitHub login Core wrote into the calling user's own home, `~/.config/gh/hosts.yml`,
 * and nothing else: no `gh` is needed in the image, no token is in the environment, and nobody's
 * push uses another person's login. The home is the user's passwd home, never `$HOME`, so a tool
 * that moves `HOME` still pushes as its user. `mend-git-credential token` prints the token for a
 * command that needs one: `GH_TOKEN=$(mend-git-credential token) gh …`, so it never reaches a
 * terminal or an agent's transcript.
 */

/** Where the helper is staged in the workspace, and what the system git config names. */
export const GIT_CREDENTIAL_HELPER_PATH = "/run/mend/bin/mend-git-credential";

export const GIT_CREDENTIAL_HELPER_SCRIPT = `#!/usr/bin/env node
// mend-git-credential — git's credential helper for https://github.com. It answers with the
// GitHub login in this user's own ~/.config/gh/hosts.yml and never prints it anywhere else.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The user's passwd home, never $HOME: a tool that moves HOME still answers as its user.
const homeOf = () => { try { return os.userInfo().homedir; } catch { return os.homedir(); } };
const HOSTS = path.join(homeOf(), ".config", "gh", "hosts.yml");
const USAGE = "usage: mend-git-credential get (git's credential helper) | token (for a command: GH_TOKEN=$(mend-git-credential token) gh …)\\n";

// The github.com entry: its first-level keys only (a nested users: map is not the active login).
const login = () => {
  let text;
  try { text = fs.readFileSync(HOSTS, "utf8"); } catch { return null; }
  let inHost = false;
  let indent = null;
  let token = null;
  let user = null;
  for (const line of text.split(/\\r?\\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\\s/.test(line)) {
      inHost = /^["']?github\\.com["']?\\s*:\\s*$/.test(line);
      indent = null;
      continue;
    }
    if (!inHost) continue;
    const width = line.length - line.trimStart().length;
    if (indent === null) indent = width;
    if (width !== indent) continue;
    const match = /^\\s+(oauth_token|user)\\s*:\\s*["']?([^"'\\s#]+)["']?\\s*$/.exec(line);
    if (match === null) continue;
    if (match[1] === "oauth_token") token = match[2];
    else user = match[2];
  }
  return token === null ? null : { token, user };
};

const verb = process.argv[2] || "";
if (verb === "token") {
  const found = login();
  if (found === null) {
    process.stderr.write("mend: no GitHub login in " + HOSTS + "\\n");
    process.exit(1);
  }
  process.stdout.write(found.token + "\\n");
  process.exit(0);
}
if (verb === "" || verb === "help" || verb === "--help") {
  process.stderr.write(USAGE);
  process.exit(verb === "" ? 2 : 0);
}
if (verb !== "get") process.exit(0);

let input = "";
process.stdin.on("data", (chunk) => (input += String(chunk)));
process.stdin.on("end", () => {
  const asked = {};
  for (const line of input.split(/\\r?\\n/)) {
    const at = line.indexOf("=");
    if (at > 0) asked[line.slice(0, at)] = line.slice(at + 1);
  }
  if (asked.protocol !== "https" || asked.host !== "github.com") process.exit(0);
  const found = login();
  if (found === null) process.exit(0);
  process.stdout.write("username=" + (found.user || "x-access-token") + "\\npassword=" + found.token + "\\n");
});
`;
