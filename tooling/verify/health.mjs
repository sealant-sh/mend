import { SSH_HINT } from "./box.mjs";

// `verify health --from local,host,workspace`: from where a Mend server is and is not reachable.
// Box checks kept meeting the same confusion: `mend server upgrade` waits on the app URL from the
// box itself, which cannot always reach it while the server is healthy from everywhere else. Each
// vantage asks the same question, GET <url>/api/health, and reports what it saw, never a guess.
//
// - local: this machine.
// - host: the server's machine, over the box's ssh (MEND_VERIFY_BOX_SSH).
// - workspace: a throwaway container on the server's Docker, started from the server's own image,
//   as a Docker workspace sees the network. It also asks the session endpoint /api/health names,
//   the address a workspace calls back to. Boat workspaces run elsewhere and are not covered.

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
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' mend-mend-1 2>/dev/null | grep -E '^APP_URL=' | head -1
echo "IMAGE=$(docker inspect --format '{{.Config.Image}}' mend-mend-1 2>/dev/null)"
command -v node >/dev/null && echo NODE=node || { test -x /opt/node/bin/node && echo NODE=/opt/node/bin/node; }
`);
  const value = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(run.stdout)?.[1]?.trim() || null;
  return {
    code: run.code,
    appUrl: value("APP_URL"),
    image: value("IMAGE"),
    node: value("NODE"),
    stderr: run.stderr,
  };
};

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
  if (from.includes("workspace")) {
    if (ssh === null) blocked("workspace", "no box named");
    else if (server.image === null)
      blocked("workspace", "no mend-mend-1 container to take an image from");
    else {
      const seen = probes.find((probe) => probe.sessionEndpoint)?.sessionEndpoint ?? null;
      const urls = [healthUrl(target), ...(seen && seen !== target ? [healthUrl(seen)] : [])];
      const run = ssh(
        `docker run --rm --pull never --entrypoint node ${quote(server.image)} --input-type=module -e ${quote(FETCH(urls))}`,
      );
      const answers = parseLines(run.stdout);
      record(
        "workspace",
        target,
        answers.get(urls[0]) ??
          readAnswer(null, "", run.stderr.trim().split("\n").at(-1) || `exit ${run.code}`),
      );
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
    server: server ? { appUrl: server.appUrl, image: server.image } : null,
  };
};
