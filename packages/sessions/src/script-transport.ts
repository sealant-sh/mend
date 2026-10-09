/**
 * Shared transport prelude for the staged scripts: the session socket when it is mounted,
 * else the network endpoint the launch env names. Dependency-free node. The token is read from
 * the environment, or from the file `MEND_SESSION_TOKEN_FILE` names, and only ever placed in an
 * Authorization header — never printed, never logged.
 *
 * In a person-layout executor (docs/adr/0016, decision 4) every process Mend starts names its
 * person's token file, and any other process of a person finds it in their passwd home (review
 * of mend#553, P2-1): the script then speaks as that person, over the endpoint only, and never
 * through a socket (a socket carries no token, so whoever answers on it would decide who pushes)
 * nor with the workspace's own token, which the server refuses there anyway.
 */
export const SCRIPT_TRANSPORT_PRELUDE = `const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");

const SOCKET = "/run/mend/mend.sock";
const ENDPOINT = process.env.MEND_SESSION_ENDPOINT || "";
const SESSION_ID = process.env.MEND_SESSION_ID || "";
// A person's process Mend started without its environment (a setup command, the dependency
// install, a Remote-SSH login) still speaks as its own user: the token file in its passwd home,
// from passwd, never $HOME. Root, and a user with no such file, use the workspace's token as before.
const TOKEN_FILE = (() => {
  const named = process.env.MEND_SESSION_TOKEN_FILE || "";
  if (named !== "") return named;
  if (typeof process.getuid !== "function" || process.getuid() === 0) return "";
  let home = "";
  try { home = require("node:os").userInfo().homedir; } catch { return ""; }
  const own = home + "/.mend/session-token";
  return home !== "" && fs.existsSync(own) ? own : "";
})();
const TOKEN = (() => {
  if (TOKEN_FILE === "") return process.env.MEND_SESSION_TOKEN || "";
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; }
})();

// Transport selection: the Docker bind mount first, then the Kubernetes network endpoint. A
// person's process (a token file named) takes the endpoint alone.
const transport = (() => {
  if (TOKEN_FILE === "" && fs.existsSync(SOCKET)) return { kind: "socket" };
  if (TOKEN_FILE !== "" && TOKEN === "") {
    return { kind: "broken", reason: "this process's Mend session token (" + TOKEN_FILE + ") cannot be read" };
  }
  if (ENDPOINT !== "" && SESSION_ID !== "" && TOKEN !== "") {
    let url;
    try { url = new URL(ENDPOINT); } catch { return { kind: "broken", reason: "MEND_SESSION_ENDPOINT is not a URL" }; }
    return { kind: "network", url };
  }
  return { kind: "none" };
})();

const transportUnavailable = () => {
  if (transport.kind === "broken") return transport.reason;
  return "no session channel in this workspace: /run/mend/mend.sock is not mounted and MEND_SESSION_ENDPOINT is not set";
};

const transportClient = () =>
  transport.kind === "network" && transport.url.protocol === "https:" ? https : http;

// Request options for either transport; extra headers ride along unchanged.
const transportOptions = (method, route, headers) => {
  if (transport.kind === "socket") {
    return { socketPath: SOCKET, method, path: route, headers: headers || {} };
  }
  if (transport.kind === "network") {
    return {
      host: transport.url.hostname,
      port: transport.url.port || (transport.url.protocol === "https:" ? 443 : 80),
      method,
      path: route,
      headers: Object.assign(
        { authorization: "Bearer " + TOKEN, "x-mend-session-id": SESSION_ID },
        headers || {},
      ),
    };
  }
  return null;
};

const transportDownMessage = () =>
  transport.kind === "socket"
    ? "mend.sock is not answering — is the Mend server up?"
    : "the Mend session endpoint (" + transport.url.host + ") is not answering — is the Mend server up?";
`;

/**
 * `redeemPickup(ticket, done)`, after the prelude: one POST of the ticket to `/pickup` over the
 * channel (`pickup-tickets.ts`), and `done(null, files)` with a Map from each path to its bytes,
 * or `done(reason)` saying why there are none. The reason never quotes the answer's body beyond
 * the server's own message, so no byte of a file reaches stdout or stderr from here.
 */
export const SCRIPT_PICKUP_FUNCTION = `const redeemPickup = (ticket, done) => {
  let settled = false;
  const finish = (reason, files) => { if (settled) return; settled = true; done(reason, files); };
  const options = transportOptions("POST", "/pickup", { "content-type": "application/json" });
  if (options === null) return finish("the pickup could not run: " + transportUnavailable());
  const request = transportClient().request(options, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("error", () => finish("the pickup's answer was cut off"));
    response.on("end", () => {
      let answer = null;
      try { answer = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      if (response.statusCode !== 200 || answer === null || !Array.isArray(answer.files)) {
        const why = answer !== null && typeof answer.message === "string" ? answer.message : "HTTP " + response.statusCode;
        return finish("the pickup was refused: " + why);
      }
      const files = new Map();
      for (const file of answer.files) {
        if (file && typeof file.path === "string" && typeof file.base64 === "string") files.set(file.path, Buffer.from(file.base64, "base64"));
      }
      finish(null, files);
    });
  });
  request.setTimeout(20000, () => request.destroy(new Error("timeout")));
  request.on("error", () => finish("the pickup could not reach Mend: " + transportDownMessage()));
  request.end(JSON.stringify({ ticket }));
};
`;

/**
 * `pinnedPut(dir, name, stagingName, bytes)`, for files that must not leave the directory they
 * were proved in: `null` once `bytes` are at `<dir>/<name>`, 0600, else why not. The directory is
 * opened once (no link at its last component) and every later step goes through that descriptor
 * (`/proc/self/fd/<n>/…`), so a directory renamed away mid-write keeps the staging file with it and
 * the cleanup reaches it there. Before the write and again before the rename the directory at the
 * literal path must be that same directory, physically where its name says; otherwise the staging
 * file is removed and the path is said to have changed. The staging file is created exclusively,
 * never through a link, and renamed into place, so no reader sees half a file.
 */
export const SCRIPT_PINNED_PUT_FUNCTION = `const pinnedPut = (dir, name, stagingName, bytes) => {
  const c = fs.constants;
  let real;
  try { real = fs.realpathSync(dir); } catch { return "could not enter its directory"; }
  if (real !== dir) return "its directory is really " + real;
  let dfd;
  try { dfd = fs.openSync(dir, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW); } catch { return "could not enter its directory"; }
  try {
    const proc = "/proc/self/fd/" + dfd;
    const base = fs.existsSync(proc) ? proc : dir;
    const at = (entry) => base + "/" + entry;
    const same = () => {
      try {
        const pinned = fs.fstatSync(dfd);
        const named = fs.lstatSync(dir);
        return named.isDirectory() && pinned.dev === named.dev && pinned.ino === named.ino && fs.realpathSync(dir) === dir;
      } catch { return false; }
    };
    const unstage = () => { try { if (!fs.lstatSync(at(stagingName)).isDirectory()) fs.unlinkSync(at(stagingName)); } catch {} };
    if (!same()) return "its path changed during the pickup";
    unstage();
    let fd;
    try {
      fd = fs.openSync(at(stagingName), c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
      let done = 0;
      while (done < bytes.length) done += fs.writeSync(fd, bytes, done, bytes.length - done);
      fs.fchmodSync(fd, 0o600);
    } catch {
      if (fd !== undefined) unstage();
      return "could not write";
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
    if (!same()) { unstage(); return "its path changed during the pickup"; }
    try { fs.renameSync(at(stagingName), at(name)); } catch { unstage(); return "could not write"; }
    return null;
  } finally {
    try { fs.closeSync(dfd); } catch {}
  }
};
`;

/**
 * `containedPut(root, directoryMode, fileMode, target, bytes)`, for a file that must land
 * physically inside `root` (a pasted image, mend#597 review finding 2): `null` once `bytes` are at
 * `target`, `fileMode`, else why not, naming paths only. `target` must be a plain absolute path
 * below `root`. `root` is entered at its real path, and every directory below it is opened through
 * no link (`O_NOFOLLOW`), each next one through the descriptor of the last (`/proc/self/fd/<n>/…`),
 * so a link planted anywhere below `root` refuses the write instead of leading it elsewhere; with no
 * `/proc/self/fd` nothing is written. A directory missing is made with `directoryMode` in the one
 * `mkdir` (the umask cleared around it), so the mode of no directory is ever changed after the
 * fact: one put in place of the new directory keeps its own (mend#615 review, finding 2; `mkdir`
 * sets no setgid bit). The file is staged exclusively, never through a link, set `fileMode` through
 * its own descriptor, and renamed into place within the pinned directory, wherever that directory
 * is by then. Only when, after the rename, the pinned directory is still at the path `target` names
 * and that path holds the staged file is it answered `null`; otherwise the file is taken back out
 * of the pinned directory and the write refused (finding 1: a directory moved while it is written).
 */
export const SCRIPT_CONTAINED_PUT_FUNCTION = `const containedPut = (root, directoryMode, fileMode, target, bytes) => {
  const c = fs.constants;
  const path = require("path");
  if (!path.isAbsolute(root) || path.normalize(root) !== root || path.normalize(target) !== target) return "not a plain absolute path";
  if (!target.startsWith(root === "/" ? "/" : root + "/")) return "not inside " + root;
  const parts = target.slice(root === "/" ? 1 : root.length + 1).split("/");
  const name = parts.pop();
  if (name === undefined || name === "" || parts.some((part) => part === "" || part === "." || part === "..")) return "not a plain absolute path";
  let real;
  try { real = fs.realpathSync(root); } catch { return "could not enter " + root; }
  let dfd;
  try { dfd = fs.openSync(real, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW); } catch { return "could not enter " + root; }
  const proc = (fd) => "/proc/self/fd/" + fd;
  let shown = root;
  const at = (entry) => proc(dfd) + "/" + entry;
  const linked = (entry) => { try { return fs.lstatSync(at(entry)).isSymbolicLink(); } catch { return false; } };
  const enter = (entry) => fs.openSync(at(entry), c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
  try {
    if (!fs.existsSync(proc(dfd))) return "no /proc/self/fd here to keep the write inside " + root;
    for (const part of parts) {
      let next;
      try { next = enter(part); } catch (error) {
        if (error.code !== "ENOENT") return (linked(part) ? "a link: " : "not a directory: ") + shown + "/" + part;
        const mask = process.umask(0);
        try { fs.mkdirSync(at(part), directoryMode & 0o777); } catch (mkdirError) {
          if (mkdirError.code !== "EEXIST") return "could not make " + shown + "/" + part + " (" + (mkdirError.code || "error") + ")";
        } finally { process.umask(mask); }
        try { next = enter(part); } catch { return (linked(part) ? "a link: " : "not a directory: ") + shown + "/" + part; }
      }
      try { fs.closeSync(dfd); } catch {}
      dfd = next;
      shown = shown + "/" + part;
    }
    const expected = path.join(real, ...parts);
    const inPlace = () => { try { return fs.readlinkSync(proc(dfd)) === expected; } catch { return false; } };
    const moved = "its directory moved during the write";
    if (!inPlace()) return moved;
    const staging = ".mend-part-" + require("crypto").randomBytes(8).toString("hex");
    const unstage = () => { try { fs.unlinkSync(at(staging)); } catch {} };
    let fd;
    let staged;
    try {
      fd = fs.openSync(at(staging), c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
      let done = 0;
      while (done < bytes.length) done += fs.writeSync(fd, bytes, done, bytes.length - done);
      fs.fchmodSync(fd, fileMode);
      staged = fs.fstatSync(fd);
    } catch (error) {
      if (fd !== undefined) unstage();
      return "could not write (" + (error.code || "error") + ")";
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
    const ours = (stat) => stat.dev === staged.dev && stat.ino === staged.ino;
    try { fs.renameSync(at(staging), at(name)); } catch (error) { unstage(); return "could not write (" + (error.code || "error") + ")"; }
    let landed = false;
    try { landed = inPlace() && ours(fs.lstatSync(path.join(expected, name))); } catch {}
    if (!landed) {
      try { if (ours(fs.lstatSync(at(name)))) fs.unlinkSync(at(name)); } catch {}
      return moved;
    }
    return null;
  } finally {
    try { fs.closeSync(dfd); } catch {}
  }
};
`;
