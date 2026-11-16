import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { migrationNames } from "../../scripts/mend-migrations.mjs";
import {
  HOLD,
  LIST_BOX,
  chooseTidy,
  deployNeeds,
  describeTidy,
  parseListing,
  parseTidyRun,
  tidyScript,
} from "./box-tidy.mjs";

// The box-check setup (AGENTS.md, Check Features on the Box; docs/operations/preview-builds.md):
// what the box runs and whether another check holds it, the database dump before a deploy, a CLI
// packed from the same commit, and proof by patch id that the running build contains the change.
// The check itself stays a person-shaped run by another agent. `plan` and `identity` only read;
// `prepare`, `cli` and `release` change the box only with --yes. `release` tidies the box first, and
// `prepare` tidies it when it is short of room for one deploy (box-tidy.mjs says what goes).
//
// The box is named by MEND_VERIFY_BOX_SSH (or --ssh): the ssh arguments that reach it as root, such
// as `-J root@<proxmox host> root@<vm>`. preview-builds.md, "The box", says what is on it.

const HOLD_HOURS = 6;

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

/**
 * The name a check goes by on the box, in its hold, its dump and its CLI directory: the --tag it
 * gave (the scheduled main run's `main-<sha12>`), else its PR, else its commit.
 */
export const checkTag = (pr, head, tag) =>
  tag ?? (pr === undefined ? `sha-${head.sha.slice(0, 12)}` : `pr${pr}`);

const rerun = (subverb, tag) => {
  const named = /^pr\d+$/.test(tag)
    ? ` --pr ${tag.slice(2)}`
    : tag.startsWith("sha-")
      ? ""
      : ` --tag ${tag}`;
  return `pnpm verify box ${subverb} --yes${named}`;
};

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
  const listed = ssh(LIST_BOX);
  return {
    state: parseState(read.stdout),
    listing: parseListing(listed.code === 0 ? listed.stdout : ""),
  };
};

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * Tidies the box for `hold`, which must be this check's: lists it, chooses, removes exactly that,
 * and measures free space before and after. Returns the step and what to keep in the result file.
 */
const runTidy = (ssh, { hold, tag }) => {
  const listed = ssh(LIST_BOX);
  const listing = parseListing(listed.code === 0 ? listed.stdout : "");
  const choice = chooseTidy({ listing, hold, tag });
  const title = "Tidy the box (changes the box)";
  if (choice.refused)
    return {
      // Only a check that holds the box tidies, so any refusal here is a fault.
      step: { id: "tidy", title, status: "failed", detail: describeTidy(choice) },
      tidy: { refused: choice.refused },
      after: listing.free,
    };
  if (choice.images.length + choice.cache.length + choice.dumps.length === 0)
    return {
      step: {
        id: "tidy",
        title,
        status: "passed",
        detail: `nothing to remove; ${listing.free === null ? "free space unknown" : `${gib(listing.free)} free`}`,
      },
      tidy: {
        before: listing.free,
        after: listing.free,
        removed: { images: [], cache: [], dumps: [] },
        failed: [],
        kept: choice.kept,
      },
      after: listing.free,
    };
  const run = parseTidyRun(ssh(tidyScript(choice, tag)).stdout, listing);
  const gone = {
    images: choice.images.filter((image) => run.removed.images.includes(image.ref)),
    cache: (listing.cache ?? []).filter((record) => run.removed.cache.includes(record.id)),
    dumps: choice.dumps.filter((dump) => run.removed.dumps.includes(dump.path)),
  };
  const ok = run.refused === null && run.failed.length === 0 && run.after !== null;
  return {
    step: {
      id: "tidy",
      title,
      status: ok ? "passed" : "failed",
      detail: [
        run.refused ? `refused: ${run.refused}` : `removed ${describeTidy(gone)}`,
        ...run.failed.map((failure) => `could not remove ${failure.ref}: ${failure.why}`),
        `free ${run.before === null ? "unknown" : gib(run.before)} before, ${run.after === null ? "unknown" : gib(run.after)} after`,
      ].join("; "),
    },
    tidy: {
      before: run.before,
      after: run.after,
      removed: {
        images: gone.images.map(({ ref, size, why }) => ({ ref, size, why })),
        cache: { records: gone.cache.length, bytes: gone.cache.reduce((t, r) => t + r.size, 0) },
        dumps: gone.dumps.map(({ path, size }) => ({ path, size })),
      },
      failed: run.failed,
      kept: choice.kept,
    },
    after: run.after,
  };
};

const stateSteps = (root, state, { head, tag, listing }) => {
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
  const need = deployNeeds(listing);
  const short = state.free !== null && state.free < need.bytes;
  const preview = short
    ? chooseTidy({ listing, hold: { tag, head: head.sha, at: state.now }, tag })
    : null;
  steps.push({
    id: "disk",
    title: "Room for one deploy",
    status: state.free === null ? "failed" : short ? "blocked_by_prerequisite" : "passed",
    detail:
      state.free === null
        ? "free space unknown"
        : [
            `${gib(state.free)} free under /var/lib/docker; one deploy needs ${gib(need.bytes)} (image ${gib(need.parts.image)}, dump ${gib(need.parts.dump)}, workspace image ${gib(need.parts.workspace)}; measured from ${need.measured})`,
            ...(preview ? [`a tidy would remove ${describeTidy(preview)}`] : []),
          ].join("; "),
  });
  if (short) next.push(`${rerun("prepare", tag)}  # takes the hold and tidies first`);
  return { steps, next, need };
};

export const boxPlan = (root, { head, ssh, tag }) => {
  const { state, listing, error } = readState(ssh);
  if (error) return error;
  const { steps, next } = stateSteps(root, state, { head, tag, listing });
  return { steps, next, box: state };
};

/** prepare: with the box free, take the database dump and hold the box for this check. */
export const boxPrepare = (root, { head, ssh, tag, yes, stamp }) => {
  const { state, listing, error } = readState(ssh);
  if (error) return error;
  const { steps, next, need } = stateSteps(root, state, { head, tag, listing });
  const dump = `/root/backups/pre-${tag}-${stamp}.sql`;
  const blocking = steps.filter((step) => step.status !== "passed" && step.id !== "deployed");
  const onlyShort =
    blocking.length === 1 && blocking[0].id === "disk" && blocking[0].status !== "failed";
  if (blocking.length > 0 && !(yes && onlyShort)) return { steps, next, box: state };
  let tidy;
  if (onlyShort) {
    // Short of room, and free of other checks: hold the box, tidy it, and measure again.
    const hold = { tag, head: head.sha, at: state.now };
    const held = ssh(`set -euo pipefail
mkdir -p "$(dirname ${HOLD})"
printf '%s' '${JSON.stringify(hold)}' > ${HOLD}`);
    const disk = steps.find((step) => step.id === "disk");
    if (held.code !== 0) {
      disk.detail += `; could not hold the box to tidy it: ${held.stderr.trim().split("\n").at(-1)}`;
      return { steps, next, box: state };
    }
    const tidied = runTidy(ssh, { hold, tag });
    tidy = tidied.tidy;
    steps.push(tidied.step);
    if (tidied.after === null || tidied.after < need.bytes) {
      ssh(`grep -q '"tag":"${tag}"' ${HOLD} && rm -f ${HOLD}`);
      disk.detail = `after tidying, ${tidied.after === null ? "free space unknown" : gib(tidied.after)}; one deploy needs ${gib(need.bytes)}, so the box is refused and its hold lifted. Remove more by hand, or raise the box's disk`;
      return { steps, next: [], box: state, tidy };
    }
    disk.status = "passed";
    disk.detail = `after tidying, ${gib(tidied.after)} free; one deploy needs ${gib(need.bytes)}`;
  }
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
    ...(tidy ? { tidy } : {}),
  };
};

/** release: tidy the box while this check still holds it, then lift the hold. */
export const boxRelease = ({ ssh, tag, yes }) => {
  const { state, listing, error } = readState(ssh);
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
    const choice = chooseTidy({ listing, hold: state.hold, tag });
    return {
      steps: [
        {
          id: "tidy",
          title: "Tidy the box (changes the box)",
          status: "skipped",
          detail: `Would remove ${describeTidy(choice)}`,
        },
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
  const tidied = runTidy(ssh, { hold: state.hold, tag });
  const run = ssh(`rm -f ${HOLD}`);
  return {
    steps: [
      tidied.step,
      {
        id: "release",
        title: "Lift this check's hold",
        status: run.code === 0 ? "passed" : "failed",
      },
    ],
    next: [],
    tidy: tidied.tidy,
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
            ? `${dir}/node_modules/.bin/mend, version ${staged.stdout.trim().split("\n")[0]}`
            : staged.stderr.trim().split("\n").at(-1),
      },
    ],
    next: staged.code === 0 ? [`on the box: export PATH=${dir}/node_modules/.bin:$PATH`] : [],
    evidence: [{ kind: "tarball", path: packed.detail }],
    cleanup: { status: "left", left: staged.code === 0 ? [`box:${dir}`] : [] },
  };
};
