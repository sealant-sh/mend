/**
 * Shared transport prelude for the staged scripts: the session socket when it is mounted,
 * else the network endpoint the launch env names. Dependency-free node. The token is read from
 * the environment and only ever placed in an Authorization header — never printed, never logged.
 */
export const SCRIPT_TRANSPORT_PRELUDE = `const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");

const SOCKET = "/run/mend/mend.sock";
const ENDPOINT = process.env.MEND_SESSION_ENDPOINT || "";
const SESSION_ID = process.env.MEND_SESSION_ID || "";
const TOKEN = process.env.MEND_SESSION_TOKEN || "";

// Transport selection: the Docker bind mount first, then the Kubernetes network endpoint.
const transport = (() => {
  if (fs.existsSync(SOCKET)) return { kind: "socket" };
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
