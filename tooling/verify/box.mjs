import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { migrationNames } from "../../scripts/mend-migrations.mjs";
import { describeFront, endFrontRun, frontOnly, readFrontRun } from "./box-front.mjs";
import {
  HOLD,
  LIST_BOX,
  chooseTidy,
  deployNeeds,
  describeTidy,
  describeUsage,
  parseListing,
  parseTidyRun,
  tidyScript,
} from "./box-tidy.mjs";
import { driveResults } from "./evidence.mjs";
import { boxFlows, loadFlows, webAppOf } from "./flows.mjs";

// The box-check setup (AGENTS.md, Check Features on the Box; docs/operations/preview-builds.md):
// what the box runs and whether another check holds it, the database dump before a deploy, a CLI
// packed from the same commit, and proof by patch id that the running build contains the change.
// The check itself stays a person-shaped run by another agent. `plan` and `identity` only read;
// `prepare`, `cli` and `release` change the box only with --yes. `release` tidies the box first, and
// `prepare` tidies it when it is short of room for one deploy (box-tidy.mjs says what goes).
// A change that is only the new web app needs no deploy: `verify drive new-web --box` serves it
// from this checkout in front of the box's API (box-front.mjs), and identity accepts that drive.
//
// The box is named by MEND_VERIFY_BOX_SSH (or --ssh): the ssh arguments that reach it as root, such
// as `-J root@<proxmox host> root@<vm>`. preview-builds.md, "The box", says what is on it.

const HOLD_HOURS = 6;

/** The installed server's pointer to its generation, an immutable snapshot of its configuration. */
const CONFIG = "/root/.config/mend";
const ACTIVE = `${CONFIG}/active`;
const GENERATION = /^generations\/gen-[0-9a-f-]{36}$/;

/**
 * Where `--load` and `--save` may read and write a pg_dumpall: a `.sql` file under /root, by a
 * plain path. A dump outside /root/backups is never tidied.
 */
export const DATA_PATH =
  /^\/root\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.sql$/;

/** Single-quotes a value for the box's shell. */
const shq = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

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
echo "webapp=$(label dev.sealant.mend.web-app)"
echo "started=$(docker inspect --format '{{.State.StartedAt}}' mend-mend-1 2>/dev/null)"
echo "running=$(docker inspect --format '{{.State.Running}}' mend-mend-1 2>/dev/null)"
echo "live=$(docker exec mend-postgres-1 psql -U postgres -d mend -At -c 'select count(*) from agent_sessions where settled_at is null' 2>/dev/null)"
echo "free=$(df -B1 --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -d ' ')"
echo "hold=$(cat ${HOLD} 2>/dev/null | tr -d '\\n')"
echo "active=$(readlink ${ACTIVE} 2>/dev/null)"
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
    webApp: webAppOf(values.webapp),
    started: values.started ?? null,
    running: values.running === "true" ? true : values.running === "false" ? false : null,
    live: /^\d+$/.test(values.live ?? "") ? Number(values.live) : null,
    free: /^\d+$/.test(values.free ?? "") ? Number(values.free) : null,
    now: values.now ?? null,
    hold,
    active: GENERATION.test(values.active ?? "") ? values.active : null,
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

/** frontOnly for the box's revision, fetched when this clone lacks it; never throws. */
const frontOf = (root, head, revision) => {
  if (revision !== null && !hasCommit(root, revision))
    spawnSync("git", ["fetch", "--quiet", "origin", revision], { cwd: root, stdio: "ignore" });
  try {
    return frontOnly(root, {
      head,
      revision: revision !== null && hasCommit(root, revision) ? revision : null,
    });
  } catch {
    return { front: false, product: [], outside: [], server: null };
  }
};

/**
 * Which flows of the daily run (.agents/skills/box-main-run/flows.md, at this head) the box can
 * show, by the web app its image serves: on today's app the flows marked `Box: after cut-over`
 * wait for cut-over; on a preview built with `web_app=web` every flow runs.
 */
const flowsStep = (root, state) => {
  const { flows } = loadFlows(root);
  const { run, afterCutOver } = boxFlows(flows, state.webApp);
  return {
    id: "flows",
    title: "The flows this box can show",
    status: "passed",
    detail:
      state.webApp === "web"
        ? `it serves apps/web (a preview built with web_app=web): all ${run.length} flows run, the ${flows.filter((flow) => flow.afterCutOver).length} marked after cut-over included`
        : `it serves apps/web-old: ${run.length} flows run, and the ${afterCutOver.length} marked after cut-over are reported as not run · after cut-over`,
  };
};

const stateSteps = (root, state, { head, tag, listing, load }) => {
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
  steps.push(flowsStep(root, state));
  const front = frontOf(root, head, state.revision);
  const noDeploy = front.front && ["same", "later"].includes(front.server);
  // A new web app check drives the box's API as it runs now, so Mend must be running there: a
  // release that put the data back leaves it stopped until the next deploy.
  const stopped = noDeploy && state.running === false;
  if (front.front)
    steps.push({
      id: "front",
      title: "How this check reaches the box",
      status: stopped ? "blocked_by_prerequisite" : "passed",
      detail: stopped
        ? `${describeFront(front, state.revision)}, but Mend is stopped there (a release that put the data back leaves it so): deploy a preview of main after pnpm verify box prepare --yes, then drive`
        : noDeploy
          ? `${describeFront(front, state.revision)}. This change is the new web app's alone: pnpm verify drive new-web --box serves it from this checkout in front of the box's API, so no preview deploy is needed`
          : describeFront(front, state.revision),
    });
  const problems = schemaProblems(state.migrations, headMigrations(root));
  // With --load, the check deploys over the data it loads, never over the box's own: prepare
  // checks the loaded data's schema once it is in.
  const elsewhere = load !== undefined;
  steps.push({
    id: "schema",
    title: "The box's Mend migrations against this head's",
    status:
      state.migrations.length === 0
        ? "failed"
        : problems.length > 0 && !noDeploy && !elsewhere
          ? "blocked_by_prerequisite"
          : "passed",
    detail:
      state.migrations.length === 0
        ? "No applied migrations could be read"
        : problems.length > 0
          ? noDeploy
            ? `${problems.join("; ")}; this check deploys nothing, so they do not apply`
            : elsewhere
              ? `${problems.join("; ")}; this check loads ${load} and deploys over that, so they do not apply`
              : `${problems.join("; ")}. Deploy a build that contains them (a preview branch of this head merged with what the box runs)`
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
            describeUsage(listing),
            ...(preview ? [`a tidy would remove ${describeTidy(preview)}`] : []),
          ].join("; "),
  });
  if (short && steps.every((step) => step.id === "disk" || step.status === "passed"))
    next.push(`${rerun("prepare", tag)}  # takes the hold and tidies first`);
  return { steps, next, need };
};

export const boxPlan = (root, { head, ssh, tag, load }) => {
  const { state, listing, error } = readState(ssh);
  if (error) return error;
  const { steps, next } = stateSteps(root, state, { head, tag, listing, load });
  return { steps, next, box: state };
};

/** Reads restoreScript's output: whether it finished, and the psql errors it printed. */
const restoreOutcome = (run) => {
  const lines = run.stdout.split("\n");
  return {
    done: lines.includes("restore=done"),
    errors: lines.filter((line) => line.startsWith("error=")).map((line) => line.slice(6)),
    refused:
      lines.find((line) => line.startsWith("restore=") && line !== "restore=done")?.slice(8) ??
      (run.code === 0 ? null : `restore exited ${run.code}`),
  };
};

/**
 * The store archive kept beside a `--load`/`--save` dump: the store directories that dump's data
 * names. The box's store is wiped with its databases, so the data never travels without it.
 */
export const storeArchiveOf = (dump) => dump.replace(/\.sql$/, ".store.tgz");

/**
 * Shell that sets `$mount` to the store volume's directory on the host, `$repos` to the
 * repositories the loaded data names (relative to it), and `$dirs` to the store directories it
 * names: each project's, and each organization's.
 */
const STORE_DIRS = `vol=$(sed -n 's/^MEND_STORE_VOLUME_NAME=//p' ${ACTIVE}/server.env 2>/dev/null)
mount=$(docker volume inspect -f '{{.Mountpoint}}' "\${vol:-mend-store}") || { echo "store=no store volume \${vol:-mend-store}"; exit 1; }
sq() { docker exec mend-postgres-1 psql -U postgres -d mend -At -c "$1"; }
paths=$(sq "select store_path from projects") || { echo "store=the projects could not be read"; exit 1; }
orgs=$(sq "select id from organizations") || { echo "store=the organizations could not be read"; exit 1; }
repos=""
dirs=""
for p in $paths; do
  r=\${p#/var/lib/mend/store/}
  case "$r" in "$p"|.*|*..*) continue ;; esac
  repos="$repos $r"
  dirs="$dirs \${r%%/*}"
done
for o in $orgs; do
  case "$o" in *[!A-Za-z0-9_-]*) continue ;; esac
  dirs="$dirs _organizations/$o"
done`;

/**
 * Puts the store archive beside `load` into the store volume, when there is one, and lists the
 * repositories the loaded data names that the store lacks. Mend is stopped.
 */
export const storeLoadScript = (load) => `# store-load
set -uo pipefail
archive=${shq(storeArchiveOf(load))}
${STORE_DIRS}
if [ -s "$archive" ]; then
  tar -xzpf "$archive" --numeric-owner -C "$mount" || { echo "store=could not extract $archive"; exit 1; }
  echo "extracted=$archive"
fi
missing=""
for r in $repos; do [ -d "$mount/$r" ] || missing="$missing $r"; done
echo "missing=\${missing# }"
echo "store=done"
`;

const storeStep = (ssh, { load }) => {
  const run = ssh(storeLoadScript(load));
  const lines = run.stdout.split("\n");
  const value = (key) =>
    lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
  const missing = (value("missing") ?? "").split(" ").filter(Boolean);
  const ok = value("store") === "done" && missing.length === 0;
  const archive = storeArchiveOf(load);
  return {
    id: "store",
    title: `Put ${archive} into the box's store (changes the box)`,
    status: ok ? "passed" : "failed",
    detail: ok
      ? value("extracted")
        ? `extracted ${archive}; every repository the loaded data names is in the store`
        : `no ${archive}; every repository the loaded data names is in the store already`
      : [
          value("store") === "done" ? null : (value("store") ?? `store-load exited ${run.code}`),
          missing.length > 0
            ? `the store lacks ${missing.length} repositories the loaded data names: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}${value("extracted") ? "" : ` (no ${archive})`}`
            : null,
          "the hold stays: pnpm verify box release --yes puts the box's own data and build back",
        ]
          .filter(Boolean)
          .join("; "),
  };
};

/**
 * prepare --load: once this check holds the box and its own data is dumped, replace that data with
 * the dump at `load` (the check's own, kept between its runs), and check that this head can deploy
 * over it. Mend stays stopped until the deploy. Release puts the box's own data and build back.
 */
const loadStep = (root, ssh, { head, load }) => {
  const title = `Load ${load} in place of the box's data (changes the box)`;
  const outcome = restoreOutcome(ssh(restoreScript(load)));
  const after = readState(ssh).state;
  const problems = after ? schemaProblems(after.migrations, headMigrations(root)) : [];
  const ok =
    outcome.done &&
    outcome.errors.length === 0 &&
    after !== undefined &&
    after.migrations.length > 0 &&
    problems.length === 0;
  return {
    id: "load",
    title,
    status: ok ? "passed" : "failed",
    detail: ok
      ? `loaded ${load}: ${after.migrations.length} Mend migrations, all in this head; Mend is stopped until the deploy starts it`
      : [
          outcome.refused,
          ...outcome.errors.map((error) => `psql: ${error}`),
          after === undefined ? "the box could not be read after the load" : null,
          after?.migrations.length === 0 ? "no applied migrations could be read after it" : null,
          ...problems,
          "the hold stays: pnpm verify box release --yes puts the box's own data and build back",
        ]
          .filter(Boolean)
          .join("; "),
  };
};

/**
 * prepare: with the box free, take the database dump and hold the box for this check. With
 * `load`, it then loads that dump in place of the box's data, and records in its hold the build
 * and the hold it found, for release to put back.
 */
export const boxPrepare = (root, { head, ssh, tag, yes, stamp, load }) => {
  const { state, listing, error } = readState(ssh);
  if (error) return error;
  const { steps, next, need } = stateSteps(root, state, { head, tag, listing, load });
  const dump = `/root/backups/pre-${tag}-${stamp}.sql`;
  if (load !== undefined && state.active === null)
    return {
      steps: [
        ...steps,
        {
          id: "load",
          title: `Load ${load} in place of the box's data`,
          status: "failed",
          detail: `${ACTIVE} names no generation, so the box's build could not be put back afterwards. Nothing was changed`,
        },
      ],
      next: [],
      box: state,
    };
  // What the box runs, and whether a new web app check needs a deploy first, never refuse the dump:
  // the deploy comes after it.
  const blocking = steps.filter(
    (step) => step.status !== "passed" && !["deployed", "front"].includes(step.id),
  );
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
          detail: `Would write ${dump} with pg_dumpall and hold the box for ${tag} in ${HOLD}${
            load === undefined
              ? ""
              : `, then load ${load} in place of its data; release would put back ${state.version} (${state.active})${state.hold && state.hold.tag !== tag ? ` and the hold ${state.hold.tag ?? "found"}` : ""}`
          }. Nothing was changed`,
        },
      ],
      next: [rerun("prepare", tag) + (load === undefined ? "" : ` --load ${load}`)],
      box: state,
    };
  }
  // A hold that lapsed (another check's in force refuses above) is written back at release.
  const found = state.hold && state.hold.tag !== tag && !state.hold.unreadable ? state.hold : null;
  const hold = JSON.stringify({
    tag,
    head: head.sha,
    at: state.now,
    dump,
    ...(load === undefined
      ? {}
      : { putBack: { active: state.active, version: state.version, hold: found } }),
  });
  const run = ssh(`
set -euo pipefail
${
  load === undefined
    ? ""
    : `[ -s ${shq(load)} ] || { echo ${shq(`no dump at ${load}`)} >&2; exit 1; }
tail -c 200 ${shq(load)} | grep -q 'dump complete' || { echo ${shq(`${load} has no pg_dumpall trailer`)} >&2; exit 1; }
`
}mkdir -p /root/backups "$(dirname ${HOLD})"
docker exec mend-postgres-1 pg_dumpall -U postgres > ${dump}
tail -c 200 ${dump} | grep -q 'dump complete'
stat -c %s ${dump}
printf '%s' ${shq(hold)} > ${HOLD}
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
  const loaded = run.code === 0 && load !== undefined ? loadStep(root, ssh, { head, load }) : null;
  if (loaded) steps.push(loaded);
  if (loaded?.status === "passed") steps.push(storeStep(ssh, { load }));
  return {
    steps,
    next:
      run.code !== 0
        ? next
        : steps.some((step) => ["load", "store"].includes(step.id) && step.status === "failed")
          ? [rerun("release", tag)]
          : [rerun("cli", tag), "pnpm verify box identity"],
    box: state,
    cleanup: { status: "left", left: run.code === 0 ? [`box:${dump}`, `box:${HOLD}`] : [] },
    ...(tidy ? { tidy } : {}),
  };
};

/**
 * The Mend migrations `origin/main` carries, fetched fresh: what a deploy of plain main can run
 * over. Null when they cannot be read.
 */
export const mainMigrations = (root) => {
  spawnSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: root, stdio: "ignore" });
  try {
    return migrationNames(git(root, ["show", "origin/main:packages/db/src/migrations.ts"]));
  } catch {
    return null;
  }
};

const DUMP_PATH = /^\/root\/backups\/[A-Za-z0-9._-]+\.sql$/;

/**
 * Puts the box's databases back to `dump`, prepare's pg_dumpall: stops the app, drops every
 * database but the templates and `postgres`, and replays the dump. Roles already exist, so their
 * CREATE ROLE errors are expected; any other error is printed. The app stays stopped: the image
 * the check deployed would apply its migrations again on start, and Mend refuses a downgrade, so
 * the next deploy is what starts Mend again.
 */
export const restoreScript = (dump) => `# restore-dump
set -uo pipefail
dump='${dump}'
[ -s "$dump" ] || { echo "restore=no dump at $dump"; exit 1; }
tail -c 200 "$dump" | grep -q 'dump complete' || { echo "restore=$dump has no pg_dumpall trailer"; exit 1; }
docker stop --time 60 mend-mend-1 >/dev/null 2>&1 || { echo "restore=could not stop mend-mend-1"; exit 1; }
q() { docker exec -i mend-postgres-1 psql -U postgres "$@"; }
for db in $(q -At -c "select datname from pg_database where not datistemplate and datname <> 'postgres'"); do
  q -v ON_ERROR_STOP=1 -q -c "drop database \\"$db\\" with (force)" >/dev/null || { echo "restore=could not drop $db"; exit 1; }
done
err=$(mktemp)
q -d postgres -q < "$dump" >/dev/null 2>"$err"
grep 'ERROR:' "$err" | grep -v 'role ".*" already exists' | head -5 | sed 's/^/error=/'
rm -f "$err"
echo "restore=done"
`;

/**
 * restore: when the check left migrations main lacks on the box, put its data back to the hold's
 * dump, so the next run of plain main is not refused. Null means release may go on.
 */
const restoreStep = (ssh, { state, yes, noRestore, main }) => {
  const title = "Put back the data a migration main lacks changed (changes the box)";
  if (main === null)
    return {
      step: {
        id: "restore",
        title,
        status: "failed",
        detail: "origin/main's migrations could not be read",
      },
      stop: true,
    };
  const extra = state.migrations.filter((name) => !main.includes(name));
  if (extra.length === 0)
    return {
      step: {
        id: "restore",
        title,
        status: "passed",
        detail: "the box applied no migration main lacks; its data stays as the check left it",
      },
    };
  const dump = state.hold?.dump ?? "";
  const which = `the box applied ${extra.join(", ")}, which main lacks`;
  if (noRestore)
    return {
      step: {
        id: "restore",
        title,
        status: "skipped",
        detail: `--no-restore: ${which}, so the box refuses a preview of main until they merge`,
      },
    };
  if (!DUMP_PATH.test(dump))
    return {
      step: {
        id: "restore",
        title,
        status: "failed",
        detail: `${which}, and the hold names no dump to restore`,
      },
      stop: true,
    };
  if (!yes)
    return {
      step: {
        id: "restore",
        title,
        status: "skipped",
        detail: `Would restore ${dump} (${which}) and leave Mend stopped until the next deploy`,
      },
    };
  const run = ssh(restoreScript(dump));
  const lines = run.stdout.split("\n");
  const errors = lines.filter((line) => line.startsWith("error=")).map((line) => line.slice(6));
  const done = lines.includes("restore=done");
  const after = readState(ssh).state;
  const left = (after?.migrations ?? extra).filter((name) => !main.includes(name));
  const ok = done && errors.length === 0 && left.length === 0;
  return {
    step: {
      id: "restore",
      title,
      status: ok ? "passed" : "failed",
      detail: ok
        ? `restored ${dump}: ${extra.join(", ")} undone; Mend is stopped on the restored data until the next deploy starts it`
        : [
            lines.find((line) => line.startsWith("restore=") && line !== "restore=done") ??
              `restore exited ${run.code}`,
            ...errors.map((error) => `psql: ${error}`),
            left.length > 0 ? `still applied: ${left.join(", ")}` : null,
            "the hold stays: put the box right by hand (docs/operations/preview-builds.md), then release again",
          ]
            .filter(Boolean)
            .join("; "),
    },
    stop: !ok,
  };
};

/**
 * Saves the data a `prepare --load` check ran on to `save`, for its next run: the databases with
 * pg_dumpall and, beside them, the store directories they name. Mend is stopped first, so both are
 * quiet. Both are written aside and replace the old pair together, which is kept as `.prev`.
 */
export const saveScript = (save) => `# save-data
set -uo pipefail
dest=${shq(save)}
archive=${shq(storeArchiveOf(save))}
mkdir -p "$(dirname "$dest")" && chmod 700 "$(dirname "$dest")" || { echo "save=could not make $(dirname "$dest")"; exit 1; }
docker stop --time 60 mend-mend-1 >/dev/null 2>&1
${STORE_DIRS.replaceAll('echo "store=', 'echo "save=')}
present=""
for d in $dirs; do [ -e "$mount/$d" ] && present="$present $d"; done
trap 'rm -f "$dest.tmp" "$archive.tmp"' EXIT
(umask 077 && docker exec mend-postgres-1 pg_dumpall -U postgres > "$dest.tmp") || { echo "save=pg_dumpall failed"; exit 1; }
tail -c 200 "$dest.tmp" | grep -q 'dump complete' || { echo "save=the dump has no pg_dumpall trailer"; exit 1; }
# shellcheck disable=SC2086 # one store directory per word
(umask 077 && tar -czpf "$archive.tmp" --numeric-owner -C "$mount" $present) || { echo "save=the store could not be archived"; exit 1; }
if [ -f "$dest" ]; then mv -f "$dest" "\${dest%.sql}.prev.sql"; fi
if [ -f "$archive" ]; then mv -f "$archive" "\${archive%.store.tgz}.prev.store.tgz"; fi
mv "$dest.tmp" "$dest" && mv "$archive.tmp" "$archive" || { echo "save=could not move the new copies into place"; exit 1; }
echo "store=$(stat -c %s "$archive") $(echo $present | wc -w)"
echo "save=$(stat -c %s "$dest")"
`;

/**
 * Points the installation back at `active`, the generation prepare --load found, and starts it as
 * an operator would. Generations are immutable snapshots, so this is the build the box ran,
 * whatever version the check deployed since; `mend server upgrade` would refuse it as a downgrade.
 */
export const startScript = (active, cliDir) => `# put-back
set -uo pipefail
cd ${CONFIG} || { echo "putback=no ${CONFIG}"; exit 1; }
target=${shq(active)}
[ -f "$target/server.env" ] || { echo "putback=no generation $target"; exit 1; }
ln -sfn "$target" .active-put-back && mv -Tf .active-put-back active || { echo "putback=could not point active at $target"; exit 1; }
cli=${shq(`${cliDir}/node_modules/.bin/mend`)}
[ -x "$cli" ] || cli=$(command -v mend)
"$cli" server start --offline >&2 || { echo "putback=mend server start exited $?"; exit 1; }
echo "putback=done"
`;

/**
 * release, for a hold prepare --load made: save the data the check ran on (with `save`), put the
 * box's own data back from the hold's dump, and start the build that was active. Stops, keeping
 * the hold, when the data or the build could not be put back.
 */
const putBackSteps = (ssh, { state, yes, noRestore, save, tag, main }) => {
  const record = state.hold.putBack;
  const dump = state.hold.dump ?? "";
  const title = `Put back the box's data and ${record.version ?? "its build"} (changes the box)`;
  const stopWith = (detail) => ({
    steps: [{ id: "put-back", title, status: "failed", detail }],
    stop: true,
  });
  if (noRestore)
    return stopWith(
      "this hold was made by prepare --load, so release always puts the box's own data back: drop --no-restore. Nothing was changed",
    );
  if (!DUMP_PATH.test(dump) || !GENERATION.test(record.active ?? ""))
    return stopWith("the hold names no dump or no generation to put back. Nothing was changed");
  const saveTitle = `Save the data this check ran on to ${save} (changes the box)`;
  if (!yes)
    return {
      steps: [
        ...(save
          ? [
              {
                id: "save",
                title: saveTitle,
                status: "skipped",
                detail: `Would stop Mend and write ${save} with pg_dumpall and ${storeArchiveOf(save)} with the store directories it names, keeping the pair before as .prev`,
              },
            ]
          : []),
        {
          id: "put-back",
          title,
          status: "skipped",
          detail: `Would restore ${dump}, point ${ACTIVE} at ${record.active} and start ${record.version}`,
        },
      ],
    };
  const steps = [];
  // Data a migration main lacks touched (a PR check's build) would be refused by the next run of
  // main: it is not saved.
  const foreign =
    save && main !== null ? state.migrations.filter((name) => !main.includes(name)) : [];
  if (save && (main === null || foreign.length > 0)) {
    steps.push({
      id: "save",
      title: saveTitle,
      status: "failed",
      detail: `${
        main === null
          ? "origin/main's migrations could not be read"
          : `the data this check ran on carries ${foreign.join(", ")}, which origin/main lacks, so a run of main could not load it`
      }; not saved: ${save} and ${storeArchiveOf(save)} are left as they were. The agent logins in them may have rotated since they were saved, so the next run may need the owner to reconnect them`,
    });
  } else if (save) {
    const run = ssh(saveScript(save));
    const lines = run.stdout.split("\n");
    const said = lines.find((line) => line.startsWith("save=")) ?? "";
    const store = (lines.find((line) => line.startsWith("store=")) ?? "store=").slice(6).split(" ");
    const bytes = Number(said.slice(5));
    const saved = run.code === 0 && Number.isInteger(bytes) && bytes > 0;
    // A save that failed keeps the dump before it; the box's own data goes back either way.
    steps.push({
      id: "save",
      title: saveTitle,
      status: saved ? "passed" : "failed",
      detail: saved
        ? `${save}: ${Math.round(bytes / 1024 ** 2)} MiB, dump complete; ${storeArchiveOf(save)}: ${Math.round(Number(store[0]) / 1024 ** 2)} MiB, ${store[1] ?? "?"} store directories`
        : `${said.slice(5) || `save exited ${run.code}`}; ${save} and ${storeArchiveOf(save)} are left as they were`,
    });
  }
  const restored = restoreOutcome(ssh(restoreScript(dump)));
  if (!restored.done || restored.errors.length > 0) {
    steps.push({
      id: "put-back",
      title,
      status: "failed",
      detail: [
        restored.refused,
        ...restored.errors.map((error) => `psql: ${error}`),
        `the hold stays: put ${dump} back by hand (docs/operations/preview-builds.md), then release again`,
      ]
        .filter(Boolean)
        .join("; "),
    });
    return { steps, stop: true };
  }
  const run = ssh(startScript(record.active, `/root/box-${tag}-cli`));
  const after = readState(ssh).state;
  const started = run.stdout.split("\n").includes("putback=done");
  const ok =
    started &&
    after?.version === record.version &&
    after.running === true &&
    after.active === record.active;
  steps.push({
    id: "put-back",
    title,
    status: ok ? "passed" : "failed",
    detail: ok
      ? `restored ${dump}; ${ACTIVE} points at ${record.active} again, and ${record.version} runs`
      : [
          `restored ${dump}`,
          run.stdout
            .split("\n")
            .find((line) => line.startsWith("putback=") && line !== "putback=done")
            ?.slice(8) ?? (started ? null : `put-back exited ${run.code}`),
          after
            ? `the box runs ${after.version ?? "nothing"} (${after.running ? "running" : "not running"}, ${after.active ?? "no generation"}), not ${record.version}`
            : "the box could not be read after the start",
          `the hold stays: start ${record.active} by hand (mend server start --offline), then release again`,
        ]
          .filter(Boolean)
          .join("; "),
  });
  return { steps, stop: !ok };
};

/**
 * release: put back the data a migration main lacks changed (or, after prepare --load, the box's
 * own data and build), tidy the box while this check still holds it, then lift the hold (or write
 * back the lapsed hold prepare --load found).
 */
const FRONT_TITLE =
  "Scan the new web app check's evidence and remove its sign-in from this machine";

/** Scans what `drive new-web --box` captured with its private registry; returns the exit code. */
const scanFront = (root, run) =>
  spawnSync(
    "node",
    [
      join(root, ".agents/skills/verify/scripts/scan-evidence.mjs"),
      "--dir",
      run.evidenceRoot ?? run.evidence,
      "--secrets",
      run.private,
      "--delete-hits",
    ],
    { cwd: root, stdio: "pipe" },
  ).status;

/**
 * The new web app check's local part (`front`: its record, scan and removal, injectable for
 * tests): its evidence scanned, then its private registry removed.
 */
export const FRONT_RUN = { read: readFrontRun, scan: scanFront, end: endFrontRun };

const endFront = (root, front) => {
  const run = front.read(root);
  if (run === null) return null;
  const code = front.scan(root, run);
  front.end(root);
  return {
    id: "front",
    title: FRONT_TITLE,
    status: code === 0 ? "passed" : code === 1 ? "evidence_withheld" : "failed",
    detail: `${code === 0 ? "no hit" : code === 1 ? "hits: those files are deleted (scan.json names them)" : `scan exited ${code}`}; removed ${run.private}; the evidence stays in ${run.evidenceRoot ?? run.evidence}`,
  };
};

export const boxRelease = ({
  root,
  ssh,
  tag,
  yes,
  noRestore = false,
  save,
  readMain = mainMigrations,
  front = FRONT_RUN,
}) => {
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
  const loaded = state.hold.putBack
    ? putBackSteps(ssh, {
        state,
        yes,
        noRestore,
        save,
        tag,
        main: save === undefined ? null : readMain(root),
      })
    : null;
  if (!loaded && save !== undefined)
    return {
      steps: [
        {
          id: "save",
          title: `Save the data this check ran on to ${save}`,
          status: "failed",
          detail:
            "this check's hold was not made by prepare --load, so there is no loaded data to save. Nothing was changed",
        },
      ],
      next: [],
    };
  const restore = loaded ? null : restoreStep(ssh, { state, yes, noRestore, main: readMain(root) });
  const before = loaded ? loaded.steps : [restore.step];
  if (loaded?.stop || restore?.stop) return { steps: before, next: [] };
  const found = state.hold.putBack?.hold ?? null;
  if (!yes) {
    const choice = chooseTidy({ listing, hold: state.hold, tag });
    const frontRun = front.read(root);
    return {
      steps: [
        ...before,
        {
          id: "tidy",
          title: "Tidy the box (changes the box)",
          status: "skipped",
          detail: `Would remove ${describeTidy(choice)}`,
        },
        ...(frontRun
          ? [
              {
                id: "front",
                title: FRONT_TITLE,
                status: "skipped",
                detail: `Would scan ${frontRun.evidenceRoot ?? frontRun.evidence} and remove ${frontRun.private}`,
              },
            ]
          : []),
        {
          id: "release",
          title: "Lift this check's hold (changes the box)",
          status: "skipped",
          detail: found
            ? `Would write back the hold ${found.tag ?? "it found"} in ${HOLD}`
            : `Would remove ${HOLD}`,
        },
      ],
      next: [rerun("release", tag) + (save === undefined ? "" : ` --save ${save}`)],
    };
  }
  const tidied = runTidy(ssh, { hold: state.hold, tag });
  const ended = endFront(root, front);
  const run = ssh(found ? `printf '%s' ${shq(JSON.stringify(found))} > ${HOLD}` : `rm -f ${HOLD}`);
  return {
    steps: [
      ...before,
      tidied.step,
      ...(ended ? [ended] : []),
      {
        id: "release",
        title: "Lift this check's hold",
        status: run.code === 0 ? "passed" : "failed",
        ...(found ? { detail: `wrote back the hold ${found.tag ?? "it found"}, as found` } : {}),
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

/**
 * Identity for a change that is the new web app's alone: the box's server is this head's, or at or
 * after this branch's base (box-front.mjs), and `drive new-web --box` drove this clean head in
 * front of the build the box runs now. Null when the change is not the front's alone.
 */
const frontIdentity = (root, { head, state }) => {
  const front = frontOf(root, head, state.revision);
  if (!front.front) return null;
  const title = "The running build contains this head";
  const where = describeFront(front, state.revision);
  if (!["same", "later"].includes(front.server))
    return {
      steps: [{ id: "identity", title, status: "failed", detail: `${state.version}: ${where}` }],
      next: [
        "build a preview of main or of this head (docs/operations/preview-builds.md) and deploy it after pnpm verify box prepare --yes",
      ],
      box: state,
    };
  const drives = driveResults(root, head).filter(
    (result) => result.drive?.surface === "new-web" && result.drive.box,
  );
  const passed = drives.filter(
    (result) => result.status === "passed" && result.drive.box.revision === state.revision,
  );
  if (passed.length === 0)
    return {
      steps: [
        {
          id: "identity",
          title,
          status: "failed",
          detail: `${state.version}: ${where}, but no passing drive new-web --box of this clean head in front of it${
            drives.length > 0
              ? ` (${drives.map((result) => `${result.drive.recipe}: ${result.status}, revision ${result.drive.box.revision?.slice(0, 12)}`).join("; ")})`
              : ""
          }`,
        },
      ],
      next: ["pnpm verify drive new-web --box --recipe <recipe>", "pnpm verify box identity"],
      box: state,
    };
  return {
    steps: [
      {
        id: "identity",
        title,
        status: "passed",
        detail: `${state.version}: ${where}; the new web app is this head's, served from this checkout by drive new-web --box (${passed.map((result) => result.drive.recipe).join(", ")})`,
      },
    ],
    next: [],
    box: state,
    identity: {
      revision: state.revision,
      version: state.version,
      relation: "front",
      server: front.server,
      drives: passed.map((result) => result.drive.recipe),
    },
  };
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
  if (!relation.contains) {
    const viaFront = frontIdentity(root, { head, state });
    if (viaFront !== null) return viaFront;
  }
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
