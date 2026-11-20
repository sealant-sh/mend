import { SSH_HINT } from "./box.mjs";

// `verify health --from local,host,workspace`: from where a Mend server is and is not reachable.
// Box checks kept meeting the same confusion: `mend server upgrade` waits on the app URL from the
// box itself, which cannot always reach it while the server is healthy from everywhere else. Each
// vantage asks the same question, GET <url>/api/health, and reports what it saw, never a guess.
//
// - local: this machine.
// - host: the server's machine, over the box's ssh (MEND_VERIFY_BOX_SSH).
// - workspace: a throwaway container on the server's Docker, started from the server's own image,
//   as a Docker workspace sees the network. It asks the session endpoint /api/health names: a
//   workspace reaches the server only through it (MEND_SESSION_ENDPOINT, or the mounted socket),
//   never through APP_URL, which only browsers and the Executor's OAuth callbacks use. The app URL
//   is still asked and recorded from there, as does-not-apply, not as a step. A server whose
//   settings offer no Docker workspaces (MEND_SESSION_RUNTIMES / MEND_SESSION_RUNTIME, as
//   packages/store/src/deployment.ts reads them) has no workspace vantage: Boat workspaces run on
//   Boat.

export const VANTAGES = ["local", "host", "workspace"];

/** Reads one probe's answer: { reachable, httpStatus, version, error }. */
export const readAnswer = (status, body, error) => {
  if (error) return { reachable: false, httpStatus: null, version: null, error };
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: something answered, but not Mend's health.
  }
  return {
    reachable: true,
    httpStatus: status,
    version: typeof parsed?.version === "string" ? parsed.version : null,
    status: typeof parsed?.status === "string" ? parsed.status : null,
    sessionEndpoint:
      typeof parsed?.sessionChannel?.endpoint === "string" ? parsed.sessionChannel.endpoint : null,
    ...(parsed === null ? { error: "the answer is not Mend's health JSON" } : {}),
  };
};

const healthUrl = (url) => new URL("/api/health", url).href;

const probeLocal = async (url, fetchImpl) => {
  try {
    const response = await fetchImpl(healthUrl(url), { signal: AbortSignal.timeout(8000) });
    return readAnswer(response.status, await response.text());
  } catch (error) {
    return readAnswer(null, "", String(error.cause?.code ?? error.message ?? error));
  }
};

// One `status<TAB>body` or `error<TAB>message` line per URL, from Node's fetch in either place.
const FETCH = (urls) =>
  `for (const u of ${JSON.stringify(urls)}) { try { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); console.log(JSON.stringify({ u, s: r.status, b: (await r.text()).slice(0, 4000) })); } catch (e) { console.log(JSON.stringify({ u, e: String(e.cause?.code ?? e.message) })); } }`;

const parseLines = (stdout) =>
  new Map(
    stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .map((row) => [row.u, row.e ? readAnswer(null, "", row.e) : readAnswer(row.s, row.b)]),
  );

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/** The server's configured app URL and image, read on its host. */
const readServer = (ssh) => {
  const run = ssh(`
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' mend-mend-1 2>/dev/null | grep -E '^(APP_URL|MEND_SESSION_RUNTIMES|MEND_SESSION_RUNTIME|MEND_DEPLOYMENT_MODE)='
echo "IMAGE=$(docker inspect --format '{{.Config.Image}}' mend-mend-1 2>/dev/null)"
command -v node >/dev/null && echo NODE=node || { test -x /opt/node/bin/node && echo NODE=/opt/node/bin/node; }
`);
  const value = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(run.stdout)?.[1]?.trim() || null;
  return {
    code: run.code,
    appUrl: value("APP_URL"),
    image: value("IMAGE"),
    node: value("NODE"),
    runtimes: offeredRuntimes({
      list: value("MEND_SESSION_RUNTIMES"),
      single: value("MEND_SESSION_RUNTIME"),
      mode: value("MEND_DEPLOYMENT_MODE"),
    }),
    stderr: run.stderr,
  };
};

/**
 * Where the server lets sessions run, read the way packages/store/src/deployment.ts reads it: the
 * list, else the single default, else Docker on a local install. Null when it cannot tell (a
 * Kubernetes install that leaves the choice to Sealant).
 */
export const offeredRuntimes = ({ list, single, mode }) => {
  if (list)
    return list
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  if (single) return [single.trim()];
  return mode === "kubernetes" ? null : ["docker"];
};

const describeRuntimes = (runtimes) => runtimes?.join(", ") ?? "unknown";

export const health = async ({ url, from, ssh, expectVersion, fetchImpl = fetch }) => {
  const steps = [];
  const next = [];
  const server = ssh ? readServer(ssh) : null;
  const target = url ?? server?.appUrl ?? null;
  if (target === null) {
    return {
      steps: [
        {
          id: "url",
          title: "The server's URL",
          status: "blocked_by_prerequisite",
          detail: "Pass --url, or name the box (MEND_VERIFY_BOX_SSH) so its APP_URL is read",
        },
      ],
      next: [SSH_HINT],
      probes: [],
    };
  }
  const probes = [];
  const record = (fromName, probeUrl, answer, extra = {}) => {
    probes.push({ from: fromName, url: probeUrl, ...answer, ...extra });
  };

  if (from.includes("local")) record("local", target, await probeLocal(target, fetchImpl));

  const blocked = (fromName, detail) => {
    record(fromName, target, { reachable: null, httpStatus: null, version: null, error: detail });
  };
  if (from.includes("host")) {
    if (ssh === null) blocked("host", "no box named");
    else if (server.node === null) blocked("host", "no node on the host to probe with");
    else {
      const run = ssh(`${server.node} --input-type=module -e ${quote(FETCH([healthUrl(target)]))}`);
      record(
        "host",
        target,
        parseLines(run.stdout).get(healthUrl(target)) ??
          readAnswer(null, "", run.stderr.trim() || `exit ${run.code}`),
      );
    }
  }
  const notApplicable = [];
  if (from.includes("workspace")) {
    if (ssh === null) blocked("workspace", "no box named");
    else if (server.runtimes !== null && !server.runtimes.includes("docker"))
      notApplicable.push({
        id: "workspace",
        why: `the server offers no Docker workspaces (session runtimes: ${describeRuntimes(server.runtimes)}); Boat workspaces run on Boat and reach the server through its session endpoint`,
      });
    else if (server.image === null)
      blocked("workspace", "no mend-mend-1 container to take an image from");
    else {
      const seen = probes.find((probe) => probe.sessionEndpoint)?.sessionEndpoint ?? null;
      const urls = [healthUrl(target), ...(seen && seen !== target ? [healthUrl(seen)] : [])];
      const run = ssh(
        // On the bundle's network, as a Docker workspace is: there the compose name of a Docker-only
        // server's session endpoint (http://mend:3106) resolves.
        `docker run --rm --pull never $(docker network inspect mend_default >/dev/null 2>&1 && echo --network mend_default) --entrypoint node ${quote(server.image)} --input-type=module -e ${quote(FETCH(urls))}`,
      );
      const answers = parseLines(run.stdout);
      const appAnswer =
        answers.get(urls[0]) ??
        readAnswer(null, "", run.stderr.trim().split("\n").at(-1) || `exit ${run.code}`);
      if (seen === null || seen === target) {
        // No session endpoint seen from here or the host, or it is the app URL: then the app URL
        // is the address to ask.
        record("workspace", target, appAnswer);
      } else {
        notApplicable.push({
          id: "workspace",
          url: target,
          seen: appAnswer.reachable === true ? `HTTP ${appAnswer.httpStatus}` : appAnswer.error,
          why: `a workspace reaches the server through its session endpoint (${seen}), never through the app URL (session runtimes: ${describeRuntimes(server.runtimes)})`,
        });
      }
      if (urls[1]) {
        record("workspace", seen, answers.get(urls[1]) ?? readAnswer(null, "", "no answer"), {
          role: "session endpoint",
        });
      }
    }
  }

  for (const probe of probes) {
    // The session endpoint is a workspace's callback address and wants a session's credential: any
    // HTTP answer shows it is reachable, which is all this probe can say about it.
    const ok = probe.role
      ? probe.reachable === true && probe.httpStatus !== null
      : probe.reachable === true &&
        probe.httpStatus === 200 &&
        probe.status === "ok" &&
        (expectVersion === undefined || probe.version === expectVersion);
    const status = probe.reachable === null ? "blocked_by_prerequisite" : ok ? "passed" : "failed";
    steps.push({
      id: `${probe.from}${probe.role ? "-session-endpoint" : ""}`,
      title: `${probe.role ?? "The server"} from ${probe.from}`,
      status,
      detail:
        probe.reachable === true
          ? `${probe.url}: HTTP ${probe.httpStatus}${probe.role ? ", reachable (it needs a session's credential, so this says nothing of readiness)" : ""}${probe.version ? `, ${probe.version}` : ""}${
              expectVersion && probe.version !== expectVersion ? `, expected ${expectVersion}` : ""
            }${probe.error && !probe.role ? `, ${probe.error}` : ""}`
          : `${probe.url}: ${probe.error}`,
    });
    if (status === "blocked_by_prerequisite" && probe.error === "no box named") next.push(SSH_HINT);
  }
  return {
    steps,
    next: [...new Set(next)],
    probes,
    notApplicable,
    server: server
      ? { appUrl: server.appUrl, image: server.image, sessionRuntimes: server.runtimes }
      : null,
  };
};
