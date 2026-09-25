import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isInside } from "./packaged-server-assertions.mjs";

const uploadPack = "git-upload-pack";
const maxCgiHeaderBytes = 64 * 1024;

/**
 * The smart-HTTP request for fetching, or null. Only upload-pack is served: a clone or fetch, never
 * a push. A shallow or partial clone (Mend's dotfiles clone is both) needs this; dumb HTTP refuses
 * `--depth`.
 */
export function uploadPackRequest(method, pathname, service) {
  if (method === "GET" && service === uploadPack && pathname.endsWith("/info/refs"))
    return pathname.slice(0, -"/info/refs".length);
  if (method === "POST" && service === null && pathname.endsWith(`/${uploadPack}`))
    return pathname.slice(0, -`/${uploadPack}`.length);
  return null;
}

/**
 * The CGI response head `git http-backend` writes before its body: `Status:` becomes the HTTP
 * status, every other line a header. Returns null until the blank line has arrived.
 */
export function cgiResponseHead(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  const [end, separator] =
    crlf !== -1 && (lf === -1 || crlf < lf) ? [crlf, 4] : lf !== -1 ? [lf, 2] : [-1, 0];
  if (end === -1) return null;
  let status = 200;
  const headers = {};
  for (const line of buffer.subarray(0, end).toString("latin1").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 500;
    else headers[name] = value;
  }
  return { status, headers, body: buffer.subarray(end + separator) };
}

/** `git http-backend` as CGI, upload-pack only, over a repository already proven inside root. */
function serveUploadPack(root, request, response, pathname, query) {
  const header = (name) => request.headers[name];
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      // docker cp keeps the runner's uid, so the served repository is not owned by the server's
      // user. Filters are allowed so a partial clone is served as one, not silently widened.
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      GIT_CONFIG_KEY_1: "uploadpack.allowFilter",
      GIT_CONFIG_VALUE_1: "true",
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: request.method,
      PATH_INFO: pathname,
      QUERY_STRING: query,
      CONTENT_TYPE: header("content-type") ?? "",
      ...(header("content-length") === undefined
        ? {}
        : { CONTENT_LENGTH: header("content-length") }),
      ...(header("content-encoding") === undefined
        ? {}
        : { HTTP_CONTENT_ENCODING: header("content-encoding") }),
      ...(header("git-protocol") === undefined
        ? {}
        : { HTTP_GIT_PROTOCOL: header("git-protocol") }),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let head = Buffer.alloc(0);
  let started = false;
  child.stdin.on("error", () => {});
  request.pipe(child.stdin);
  child.stdout.on("data", (chunk) => {
    if (started) {
      response.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const parsed = cgiResponseHead(head);
    if (parsed === null) {
      if (head.length > maxCgiHeaderBytes) child.kill("SIGKILL");
      return;
    }
    started = true;
    response.writeHead(parsed.status, { ...parsed.headers, "cache-control": "no-store" });
    response.write(parsed.body);
  });
  // A spawn that fails emits `error` and then `close`: answer once, or the second writeHead
  // throws outside the request handler and takes the fixture down for every later request.
  child.on("error", () => {
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
  });
  child.on("close", () => {
    if (!response.headersSent) response.writeHead(500).end();
    else response.end();
  });
}

/**
 * Git over HTTP from copied bare repositories: dumb HTTP for any file, and smart HTTP upload-pack
 * for shallow and partial clones. No host ports, credentials, pushes or directory listings.
 */
export function gitFixtureServer(root) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://fixture");
      const pathname = decodeURIComponent(url.pathname);
      const service = url.searchParams.get("service");
      const repository = uploadPackRequest(request.method, pathname, service);
      if (repository !== null) {
        const target = await realpath(resolve(root, `.${repository}`));
        if (!isInside(root, target) || !(await stat(target)).isDirectory()) {
          response.writeHead(404).end();
          return;
        }
        serveUploadPack(root, request, response, pathname, url.search.slice(1));
        return;
      }
      if (service !== null) {
        response.writeHead(403).end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      const target = await realpath(resolve(root, `.${pathname}`));
      if (!isInside(root, target) || !(await stat(target)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      });
      if (request.method === "HEAD") response.end();
      else
        createReadStream(target)
          .on("error", () => response.destroy())
          .pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(404).end();
      else response.destroy();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  gitFixtureServer("/fixture").listen(9080, "0.0.0.0");
}
