import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { migrationNames } from "../../scripts/mend-migrations.mjs";

// The box-check setup (AGENTS.md, Check Features on the Box; docs/operations/preview-builds.md):
// what the box runs and whether another check holds it, the database dump before a deploy, a CLI
// packed from the same commit, and proof by patch id that the running build contains the change.
// The check itself stays a person-shaped run by another agent. `plan` and `identity` only read;
// `prepare`, `cli` and `release` change the box only with --yes.
//
// The box is named by MEND_VERIFY_BOX_SSH (or --ssh): the ssh arguments that reach it as root, such
// as `-J root@<proxmox host> root@<vm>`. preview-builds.md, "The box", says what is on it.

const HOLD = "/var/lib/mend-box-check/hold.json";
const HOLD_HOURS = 6;
const MIN_FREE_BYTES = 10 * 1024 ** 3;

export const SSH_HINT = "export MEND_VERIFY_BOX_SSH='-J root@<proxmox host> root@<box vm>'";

/**
 * Runs a bash script on the box; resolves { code, stdout, stderr }. With `input`, the bytes follow
 * the script on stdin. The script goes in braces, so bash has parsed all of it before any command
 * runs, and reads it from a pipe a byte at a time, so `cat > file` reads exactly the bytes.
 * Injectable for tests.
 */
export const sshRunner =
  (sshArgs) =>
  (script, { input } = {}) => {
    const result = spawnSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...sshArgs, "bash -s"],
      {
        input: Buffer.concat([Buffer.from(`{\n${script}\n}\n`), ...(input ? [input] : [])]),
        stdio: "pipe",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return {
      code: result.status ?? 255,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  };

/** The name a check goes by on the box: its PR, else its commit. */
export const checkTag = (pr, head) =>
  pr === undefined ? `sha-${head.sha.slice(0, 12)}` : `pr${pr}`;

const rerun = (subverb, tag) =>
  `pnpm verify box ${subverb} --yes${tag.startsWith("pr") ? ` --pr ${tag.slice(2)}` : ""}`;

// One read of everything plan needs, as `key=value` lines and `migration=<id>|<name>` rows.
const READ_STATE = `
set -u
label() { docker inspect --format "{{index .Config.Labels \\"$1\\"}}" mend-mend-1 2>/dev/null; }
echo "version=$(label org.opencontainers.image.version)"
echo "revision=$(label org.opencontainers.image.revision)"
echo "started=$(docker inspect --format '{{.State.StartedAt}}' mend-mend-1 2>/dev/null)"
echo "live=$(docker exec mend-postgres-1 psql -U postgres -d mend -At -c 'select count(*) from agent_sessions where settled_at is null' 2>/dev/null)"
echo "free=$(df -B1 --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -d ' ')"
echo "hold=$(cat ${HOLD} 2>/dev/null | tr -d '\\n')"
echo "now=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker exec mend-postgres-1 psql -U postgres -d mend -At -F'|' \\
  -c 'select migration_id, name from mend_migrations order by migration_id' 2>/dev/null |
  sed 's/^/migration=/'
`;

/** Parses READ_STATE's output. Missing values are null: unknown is never zero. */
export const parseState = (text) => {
  const values = {};
  const migrations = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    if (key === "migration") {
      const [id, name] = value.split("|");
      if (/^\d+$/.test(id ?? "")) migrations.push(`${id.padStart(4, "0")}_${name}`);
    } else values[key] = value === "" ? null : value;
  }
  let hold = null;
  try {
    hold = values.hold ? JSON.parse(values.hold) : null;
  } catch {
    hold = { unreadable: values.hold };
  }
  return {
    version: values.version ?? null,
    revision: /^[0-9a-f]{40}$/.test(values.revision ?? "") ? values.revision : null,
    started: values.started ?? null,
    live: /^\d+$/.test(values.live ?? "") ? Number(values.live) : null,
    free: /^\d+$/.test(values.free ?? "") ? Number(values.free) : null,
    now: values.now ?? null,
    hold,
    migrations,
  };
};

/**
 * Compares the box's applied Mend migrations with this head's, as `mend server upgrade
 * --from-preview` does for Mend's half: one the box applied that the head lacks would be missing
 * from the deploy, and one the head has at or below the box's highest that the box never ran would
 * be skipped for good by Effect's migrator.
 */
export const schemaProblems = (applied, head) => {
  const id = (name) => Number(name.slice(0, 4));
  const highest = Math.max(0, ...applied.map(id));
  return [
    ...applied
      .filter((name) => !head.includes(name))
      .map((name) => `the box applied ${name}, which this head lacks`),
    ...head
      .filter((name) => id(name) <= highest && !applied.includes(name))
      .map((name) => `this head's ${name} is at or below the box's ${highest} and would never run`),
  ];
};

/** Whether a hold by another check is still in force. Holds lapse after HOLD_HOURS. */
export const holdBy = (hold, now, tag) => {
  if (hold === null) return null;
  if (hold.unreadable !== undefined) return { tag: "unknown", reason: "an unreadable hold file" };
  const age = (Date.parse(now) - Date.parse(hold.at)) / 3_600_000;
  if (!(age < HOLD_HOURS) || hold.tag === tag) return null;
  return { ...hold, ageHours: Math.round(age * 10) / 10 };
};

const headMigrations = (root) =>
  migrationNames(readFileSync(join(root, "packages/db/src/migrations.ts"), "utf8"));

const unreachable = (detail) => ({
  steps: [
    { id: "reach", title: "Reach the box over ssh", status: "blocked_by_prerequisite", detail },
  ],
  next: [SSH_HINT],
});

const readState = (ssh) => {
  if (ssh === null)
    return { error: unreachable("No box named: set MEND_VERIFY_BOX_SSH or pass --ssh") };
  const read = ssh(READ_STATE);
  if (read.code !== 0 || !read.stdout.includes("version=")) {
    return {
      error: unreachable(`ssh exited ${read.code}: ${read.stderr.trim().split("\n").at(-1) ?? ""}`),
    };
  }
  return { state: parseState(read.stdout) };
};

const stateSteps = (root, state, { head, tag }) => {
  const steps = [];
  const next = [];
  steps.push({
    id: "deployed",
    title: "What the box runs",
    status: state.version && state.revision ? "passed" : "failed",
    detail: state.version
      ? `${state.version}, revision ${state.revision?.slice(0, 12) ?? "unknown"}, started ${state.started}${
          state.revision === head.sha ? " (this head)" : ""
        }`
      : "No mend-mend-1 container answered",
  });
  const holder = holdBy(state.hold, state.now, tag);
  const busy = state.live === null || state.live > 0 || holder !== null;
  steps.push({
    id: "free",
    title: "No other check holds the box",
    status: busy ? "blocked_by_prerequisite" : "passed",
    detail: [
      state.live === null ? "live sessions could not be counted" : `${state.live} live sessions`,
      holder === null
        ? "no hold"
        : `held by ${holder.tag}${holder.head ? ` (${holder.head.slice(0, 12)})` : ""} for ${holder.ageHours} h`,
    ].join("; "),
  });
  if (busy)
    next.push("wait until the other check posts its verdict and its sessions settle, then rerun");
  const problems = schemaProblems(state.migrations, headMigrations(root));
  steps.push({
    id: "schema",
    title: "The box's Mend migrations against this head's",
    status:
      state.migrations.length === 0
        ? "failed"
        : problems.length > 0
          ? "blocked_by_prerequisite"
          : "passed",
    detail:
      state.migrations.length === 0
        ? "No applied migrations could be read"
        : problems.length > 0
          ? `${problems.join("; ")}. Deploy a build that contains them (a preview branch of this head merged with what the box runs)`
          : `${state.migrations.length} applied, all in this head`,
  });
  steps.push({
    id: "disk",
    title: "Free space for a dump and images",
    status:
      state.free === null
        ? "failed"
        : state.free < MIN_FREE_BYTES
          ? "blocked_by_prerequisite"
          : "passed",
    detail:
      state.free === null
        ? "unknown"
        : `${Math.floor(state.free / 1024 ** 3)} GiB free under /var/lib/docker`,
  });
  return { steps, next };
};

export const boxPlan = (root, { head, ssh, tag }) => {
  const { state, error } = readState(ssh);
  if (error) return error;
  return { ...stateSteps(root, state, { head, tag }), box: state };
};

/** prepare: with the box free, take the database dump and hold the box for this check. */
export const boxPrepare = (root, { head, ssh, tag, yes, stamp }) => {
  const { state, error } = readState(ssh);
  if (error) return error;
  const { steps, next } = stateSteps(root, state, { head, tag });
  const dump = `/root/backups/pre-${tag}-${stamp}.sql`;
  const blocking = steps.filter((step) => step.status !== "passed" && step.id !== "deployed");
  if (blocking.length > 0) return { steps, next, box: state };
  if (!yes) {
    return {
      steps: [
        ...steps,
        {
          id: "dump",
          title: "Database dump and hold (changes the box)",
          status: "skipped",
          detail: `Would write ${dump} with pg_dumpall and hold the box for ${tag} in ${HOLD}. Nothing was changed`,
        },
      ],
      next: [rerun("prepare", tag)],
      box: state,
    };
  }
  const hold = JSON.stringify({ tag, head: head.sha, at: state.now, dump });
  const run = ssh(`
set -euo pipefail
mkdir -p /root/backups "$(dirname ${HOLD})"
docker exec mend-postgres-1 pg_dumpall -U postgres > ${dump}
tail -c 200 ${dump} | grep -q 'dump complete'
stat -c %s ${dump}
printf '%s' '${hold}' > ${HOLD}
`);
  const bytes = Number(run.stdout.trim().split("\n").at(-1));
  steps.push({
    id: "dump",
    title: "Database dump and hold (changes the box)",
    status: run.code === 0 ? "passed" : "failed",
    detail:
      run.code === 0
        ? `${dump}: ${Math.round(bytes / 1024 ** 2)} MiB, dump complete; box held for ${tag}`
        : `failed: ${run.stderr.trim().split("\n").at(-1)}`,
  });
  return {
    steps,
    next: run.code === 0 ? [rerun("cli", tag), "pnpm verify box identity"] : next,
    box: state,
    cleanup: { status: "left", left: run.code === 0 ? [`box:${dump}`, `box:${HOLD}`] : [] },
  };
};

/** release: lift this check's own hold. */
export const boxRelease = ({ ssh, tag, yes }) => {
  const { state, error } = readState(ssh);
  if (error) return error;
  const ours = state.hold?.tag === tag;
  if (!ours) {
    return {
      steps: [
        {
          id: "release",
          title: "Lift this check's hold",
          status: "passed",
          detail: state.hold
            ? `the hold is ${state.hold.tag}'s, not ${tag}'s; left alone`
            : "no hold",
        },
      ],
      next: [],
    };
  }
  if (!yes) {
    return {
      steps: [
        {
          id: "release",
          title: "Lift this check's hold (changes the box)",
          status: "skipped",
          detail: `Would remove ${HOLD}`,
        },
      ],
      next: [rerun("release", tag)],
    };
  }
  const run = ssh(`rm -f ${HOLD}`);
  return {
    steps: [
      {
        id: "release",
        title: "Lift this check's hold",
        status: run.code === 0 ? "passed" : "failed",
      },
    ],
    next: [],
  };
};

const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

const patchId = (root, from, to) => {
  const diff = execFileSync("git", ["diff", "--no-ext-diff", from, to], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  const id = execFileSync("git", ["patch-id", "--stable"], {
    cwd: root,
    input: diff,
    encoding: "utf8",
  });
  return id.split(" ")[0] || null;
};

const hasCommit = (root, sha) => {
  try {
    git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * How a running revision relates to this head: the same commit, a descendant, or a commit whose
 * diff has this change's patch id (a squash on main, or a preview merge of this head with another
 * branch). Scans at most `limit` commits.
 */
export const relate = (root, { head, revision, limit = 400 }) => {
  if (revision === head.sha) return { relation: "exact", contains: true };
  try {
    git(root, ["merge-base", "--is-ancestor", head.sha, revision]);
    return { relation: "descendant", contains: true };
  } catch {
    // Not an ancestor: look for the change by patch id.
  }
  const ours = patchId(root, head.mergeBase, head.sha);
  if (ours === null) return { relation: "empty change", contains: false, patchId: null };
  const candidates = git(root, ["rev-list", `--max-count=${limit}`, revision, `^${head.mergeBase}`])
    .split("\n")
    .filter(Boolean);
  for (const commit of candidates) {
    const parents = git(root, ["rev-list", "--parents", "-n", "1", commit])
      .trim()
      .split(" ")
      .slice(1);
    if (parents.length === 0) continue;
    if (patchId(root, parents[0], commit) === ours) {
      return { relation: "patch", contains: true, patchId: ours, via: commit };
    }
  }
  return { relation: "none", contains: false, patchId: ours, scanned: candidates.length };
};

export const boxIdentity = (root, { head, ssh }) => {
  const { state, error } = readState(ssh);
  if (error) return error;
  if (state.revision === null) {
    return {
      steps: [
        {
          id: "identity",
          title: "The running build contains this head",
          status: "failed",
          detail: "The box reports no image revision",
        },
      ],
      next: [],
      box: state,
    };
  }
  if (!hasCommit(root, state.revision)) {
    spawnSync("git", ["fetch", "--quiet", "origin", state.revision], {
      cwd: root,
      stdio: "ignore",
    });
  }
  if (!hasCommit(root, state.revision)) {
    return {
      steps: [
        {
          id: "identity",
          title: "The running build contains this head",
          status: "blocked_by_prerequisite",
          detail: `Revision ${state.revision} is not in this clone and origin did not serve it`,
        },
      ],
      next: [`git fetch origin <the preview branch that built ${state.revision.slice(0, 12)}>`],
      box: state,
    };
  }
  const relation = relate(root, { head, revision: state.revision });
  const detail = {
    exact: "the box runs this head",
    descendant: `the box runs ${state.revision.slice(0, 12)}, which has this head in its history`,
    patch: `the box runs ${state.revision.slice(0, 12)}; its commit ${relation.via?.slice(0, 12)} has this change's patch id ${relation.patchId?.slice(0, 12)}`,
    none: `the box runs ${state.revision.slice(0, 12)}; none of its ${relation.scanned} commits since the merge base has patch id ${relation.patchId?.slice(0, 12)}`,
    "empty change": "this head has no change against its merge base",
  }[relation.relation];
  return {
    steps: [
      {
        id: "identity",
        title: "The running build contains this head",
        status: relation.contains ? "passed" : "failed",
        detail: `${state.version}: ${detail}`,
      },
    ],
    next: relation.contains
      ? []
      : [
          "build a preview of this head (docs/operations/preview-builds.md) and deploy it after pnpm verify box prepare --yes",
        ],
    box: state,
    identity: { revision: state.revision, version: state.version, ...relation },
  };
};

/**
 * cli: pack @sealant/mend from this commit, and with --yes install it on the box beside the global
 * one (which no deploy updates), so the check runs commands from the same build.
 */
export const boxCli = (root, { head, ssh, tag, yes, run = spawnSync }) => {
  if (head.dirty) {
    return {
      steps: [
        {
          id: "pack",
          title: "Pack the CLI from this commit",
          status: "blocked_by_prerequisite",
          detail: "The tree has uncommitted changes: a CLI packed now would not be this commit's",
        },
      ],
      next: ["git stash or commit, then rerun"],
    };
  }
  const out = join(root, ".verify/box", `cli-${head.sha.slice(0, 12)}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pack = run("pnpm", ["--filter", "@sealant/mend", "pack", "--pack-destination", out], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
  const tarball = readdirSync(out).find((name) => name.endsWith(".tgz"));
  const packed = {
    id: "pack",
    title: "Pack the CLI from this commit",
    status: pack.status === 0 && tarball ? "passed" : "failed",
    command: "pnpm --filter @sealant/mend pack",
    detail: tarball
      ? relative(root, join(out, tarball))
      : String(pack.stderr ?? "")
          .trim()
          .split("\n")
          .at(-1),
  };
  if (packed.status !== "passed") return { steps: [packed], next: [] };
  const dir = `/root/box-${tag}-cli`;
  if (!yes) {
    return {
      steps: [
        packed,
        {
          id: "stage",
          title: "Install it on the box (changes the box)",
          status: "skipped",
          detail: `Would install ${tarball} under ${dir}. Nothing on the box was changed`,
        },
      ],
      next: [rerun("cli", tag)],
      evidence: [{ kind: "tarball", path: packed.detail }],
    };
  }
  if (ssh === null)
    return {
      ...unreachable("No box named: set MEND_VERIFY_BOX_SSH or pass --ssh"),
      steps: [packed, ...unreachable("").steps],
    };
  const staged = ssh(
    `set -euo pipefail
rm -rf ${dir} && mkdir -p ${dir}
cat > ${dir}/${tarball}
npm install --silent --no-audit --no-fund --prefix ${dir} ${dir}/${tarball} >&2
${dir}/node_modules/.bin/mend --version`,
    { input: readFileSync(join(out, tarball)) },
  );
  return {
    steps: [
      packed,
      {
        id: "stage",
        title: "Install it on the box",
        status: staged.code === 0 ? "passed" : "failed",
        detail:
          staged.code === 0
            ? `${dir}/node_modules/.bin/mend, version ${staged.stdout.trim()}`
            : staged.stderr.trim().split("\n").at(-1),
      },
    ],
    next: staged.code === 0 ? [`on the box: export PATH=${dir}/node_modules/.bin:$PATH`] : [],
    evidence: [{ kind: "tarball", path: packed.detail }],
    cleanup: { status: "left", left: staged.code === 0 ? [`box:${dir}`] : [] },
  };
};
