// What a check that holds the box may remove when it is done (SLNT-1055): what no container uses and
// no check could want back. The choice is a pure function over one listing of the box, so it is
// tested without one; the box only lists, and then removes exactly what the choice printed.
//
// Removed: Mend preview images older than the newest three; untagged images that no container uses
// and no Mend image left on the box names in a label; build cache unused for two days, internal
// records included (SLNT-1057: without --all, BuildKit's prune keeps all but dangling ones); dumps in
// /root/backups beyond the newest ten. Kept, always: any image a container uses (running or
// stopped), the newest three previews, the image the hold's own deploy pulled or built from its
// head, any image a kept Mend image pins by digest (the network guard every session launch runs,
// Boat's resource gateway), the hold's own dump, and every workspace image: sealant's worker reaps
// those itself, with its database's view of live workspaces and builds in flight
// (packages/workspaces/src/worker/reap-workspace-images.ts in sealant).
//
// A preview deploy that takes no hold (scripts/preview-deploy.sh, SLNT-1251) makes the same choice
// once it has deployed, on the box itself: `node box-tidy.mjs deploy <commit> <started>`, below. It
// stands in for a hold of its own begun when the deploy started, so the image it just pulled and the
// image of its commit are kept, and it removes nothing while a check's hold is in force: that check's
// release tidies.

import { pathToFileURL } from "node:url";

export const HOLD = "/var/lib/mend-box-check/hold.json";
/** A hold older than this has lapsed: a check that dies leaves its hold file behind. */
export const HOLD_HOURS = 6;
/** The tag a preview deploy tidies under: it holds nothing, so it guards on the hold file instead. */
export const DEPLOY_TAG = "preview-deploy";

const KEEP_PREVIEWS = 3;
const KEEP_DUMPS = 10;
const CACHE_UNUSED_HOURS = 48;
const BACKUPS = "/root/backups";

/**
 * What one deploy needed when nothing on the box says better, measured on 16 Nov 2026: preview 225
 * pulled a 2.7 GB image, prepare wrote a 0.3 GB dump, and its first session built a 7.3 GB workspace
 * image; the disk fell 10.8 GB.
 */
export const MEASURED_DEPLOY_BYTES = 11 * 1024 ** 3;

const MEND_PREVIEW = /^ghcr\.io\/sealant-sh\/mend:[^@\s]+\.preview\.\d+$/;
const WORKSPACE = /^sealant-workspace-[a-z0-9-]+[:@]/;
const DIGEST = /@(sha256:[0-9a-f]{64})$/;
/** What may be pasted into the removal script: image references, ids and dump paths. */
const SAFE_REFERENCE = /^[a-z0-9][A-Za-z0-9._/:@-]*$/;
const SAFE_DUMP = /^\/root\/backups\/[A-Za-z0-9._-]+\.sql$/;
const SAFE_TAG = /^[a-z0-9][a-z0-9.-]*$/;

/** Lists the box: images, the image each container uses, build cache, dumps and free space. */
export const LIST_BOX = `
set -u
# tidy-listing
echo "free=$(df -B1 --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -d ' ')"
echo "now=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker image ls -q --no-trunc | sort -u | xargs -r docker image inspect --format \\
  'image={{.Id}}|{{json .RepoTags}}|{{json .RepoDigests}}|{{.Created}}|{{.Metadata.LastTagTime}}|{{.Size}}|{{json (index .Config "Labels")}}'
docker ps -aq --no-trunc | xargs -r docker inspect --format 'container={{.Image}}|{{.Name}}|{{.State.Status}}'
echo "cache=$(curl -sf --unix-socket /var/run/docker.sock 'http://localhost/system/df?type=build-cache' | tr -d '\\n')"
# A box with no dumps has no ${BACKUPS}: that is no dumps, not a listing that failed.
find ${BACKUPS} -maxdepth 1 -type f -name '*.sql' -printf 'dump=%T@|%s|%p\\n' 2>/dev/null || true
`;

const json = (text, fallback) => {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};

const time = (text) => {
  const at = Date.parse(text ?? "");
  return Number.isNaN(at) || at <= 0 ? null : at;
};

/** Parses LIST_BOX's output. A part that could not be read is null, never empty. */
export const parseListing = (text) => {
  const images = [];
  const containers = [];
  const dumps = [];
  let cache = null;
  let free = null;
  let now = null;
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (key === "free" && /^\d+$/.test(value.trim())) free = Number(value.trim());
    else if (key === "now") now = time(value.trim());
    else if (key === "image") {
      const parts = value.split("|");
      const [id, tags, digests, created, pulled, size] = parts;
      const names = json(tags, []);
      images.push({
        id,
        tags: names.filter((name) => !name.includes("@")),
        digests: json(digests, []),
        created: time(created),
        pulled: time(pulled),
        size: Number(size) || 0,
        labels: json(parts.slice(6).join("|"), {}),
      });
    } else if (key === "container") {
      const [image, name, state] = value.split("|");
      containers.push({ image, name: name?.replace(/^\//, ""), state });
    } else if (key === "cache") {
      const records = json(value, null)?.BuildCache;
      if (Array.isArray(records))
        cache = records.map((record) => ({
          id: record.ID,
          type: record.Type,
          inUse: record.InUse === true,
          shared: record.Shared === true,
          size: Number(record.Size) || 0,
          lastUsed: time(record.LastUsedAt) ?? time(record.CreatedAt),
        }));
    } else if (key === "dump") {
      const [mtime, size, path] = value.split("|");
      dumps.push({ path, size: Number(size) || 0, mtime: Number(mtime) * 1000 });
    }
  }
  return { images, containers, cache, dumps: dumps.length > 0 ? dumps : null, free, now };
};

const newestFirst = (key) => (a, b) => (b[key] ?? 0) - (a[key] ?? 0);

const isPreview = (image) => image.tags.length > 0 && image.tags.every((t) => MEND_PREVIEW.test(t));

const isWorkspace = (image) => [...image.tags, ...image.digests].some((ref) => WORKSPACE.test(ref));

/**
 * What one deploy needs, from the box's own newest: a Mend preview image, a dump and a workspace
 * image (a deploy whose plan changed builds one at its first session). Falls back to the 16 Nov
 * measurement when the box has none of them.
 */
export const deployNeeds = (listing) => {
  const newest = (images) => images.toSorted(newestFirst("created"))[0]?.size ?? 0;
  const parts = {
    image: newest(listing?.images?.filter(isPreview) ?? []),
    dump: (listing?.dumps ?? []).toSorted(newestFirst("mtime"))[0]?.size ?? 0,
    workspace: newest(listing?.images?.filter(isWorkspace) ?? []),
  };
  const bytes = parts.image + parts.dump + parts.workspace;
  return bytes > 0 && parts.image > 0
    ? { bytes, parts, measured: "the box's newest preview image, dump and workspace image" }
    : { bytes: MEASURED_DEPLOY_BYTES, parts, measured: "the deploy of 16 Nov 2026 (preview 225)" };
};

/**
 * Chooses what a tidy removes. Pure: `listing` is parseListing's, `hold` the box's hold file, `tag`
 * the caller. Without the caller's own hold it removes nothing.
 */
export const chooseTidy = ({ listing, hold, tag }) => {
  const none = { images: [], cache: [], dumps: [], kept: [] };
  if (!hold || hold.unreadable !== undefined || hold.tag !== tag)
    return {
      ...none,
      refused: hold?.tag
        ? `the box is held by ${hold.tag}, not ${tag}`
        : `${tag} does not hold the box`,
    };
  if (listing.now === null) return { ...none, refused: "the box's clock could not be read" };
  // A Mend box always runs containers: an empty list means the listing failed, not that none use
  // an image.
  if (listing.containers.length === 0) return { ...none, refused: "no containers could be listed" };
  const heldAt = time(hold.at) ?? Number.POSITIVE_INFINITY;
  const used = new Set(listing.containers.map((container) => container.image));
  const kept = [];
  const keep = (image, why) => {
    kept.push({ ref: image.tags[0] ?? image.digests[0] ?? image.id, why });
    return true;
  };
  const ownDeploy = (image) =>
    (image.pulled ?? 0) >= heldAt ||
    (hold.head !== undefined && image.labels?.["org.opencontainers.image.revision"] === hold.head);

  const previews = listing.images.filter(isPreview).toSorted(newestFirst("created"));
  const newest = new Set(previews.slice(0, KEEP_PREVIEWS).map((image) => image.id));
  const oldPreviews = previews.filter(
    (image) =>
      !(used.has(image.id) && keep(image, "a container uses it")) &&
      !(newest.has(image.id) && keep(image, `one of the newest ${KEEP_PREVIEWS} previews`)) &&
      !(ownDeploy(image) && keep(image, "this hold's own deploy")),
  );
  const leaving = new Set(oldPreviews.map((image) => image.id));
  const pinned = new Set(
    listing.images
      .filter((image) => !leaving.has(image.id))
      .flatMap((image) => Object.values(image.labels ?? {}))
      .map((value) => DIGEST.exec(String(value))?.[1])
      .filter(Boolean),
  );
  const untagged = listing.images.filter(
    (image) =>
      image.tags.length === 0 &&
      !isWorkspace(image) &&
      !(used.has(image.id) && keep(image, "a container uses it")) &&
      !(
        [image.id, ...image.digests.map((ref) => DIGEST.exec(ref)?.[1])].some((d) =>
          pinned.has(d),
        ) && keep(image, "a Mend image on the box pins it by digest")
      ) &&
      !(ownDeploy(image) && keep(image, "this hold's own deploy")),
  );
  const images = [
    ...oldPreviews.flatMap((image) =>
      image.tags.map((ref, index) => ({
        ref,
        id: image.id,
        size: index === 0 ? image.size : 0,
        why: `a preview older than the newest ${KEEP_PREVIEWS}`,
      })),
    ),
    ...untagged.map((image) => ({
      ref: image.id,
      id: image.id,
      size: image.size,
      why: "untagged, and nothing uses or pins it",
    })),
  ].filter((image) => SAFE_REFERENCE.test(image.ref));

  const cutoff = listing.now - CACHE_UNUSED_HOURS * 3_600_000;
  const cache = (listing.cache ?? []).filter(
    (record) => !record.inUse && record.lastUsed !== null && record.lastUsed < cutoff,
  );

  const dumps = (listing.dumps ?? [])
    .toSorted(newestFirst("mtime"))
    .slice(KEEP_DUMPS)
    .filter((dump) => dump.path !== hold.dump && SAFE_DUMP.test(dump.path));

  return { images, cache, dumps, kept };
};

/**
 * What a preview deploy that took no hold removes once it has deployed: chooseTidy's choice, for a
 * hold begun at `startedAt` naming `commit`. Refused while a check's hold is in force (younger than
 * HOLD_HOURS, or unreadable); a lapsed hold's dump is kept as that check's own.
 */
export const chooseDeployTidy = ({ listing, hold, commit, startedAt }) => {
  const none = { images: [], cache: [], dumps: [], kept: [] };
  if (hold?.unreadable !== undefined)
    return { ...none, refused: "the box's hold file could not be read" };
  const age = hold ? ((listing.now ?? Date.now()) - (time(hold.at) ?? 0)) / 3_600_000 : null;
  if (hold && age < HOLD_HOURS)
    return {
      ...none,
      refused: `${hold.tag ?? "a check"} holds the box (${age.toFixed(1)} h); its release tidies it`,
    };
  return chooseTidy({
    listing,
    hold: { tag: DEPLOY_TAG, at: startedAt, head: commit, dump: hold?.dump },
    tag: DEPLOY_TAG,
  });
};

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * What fills the box besides previews and dumps, for `plan`: the build cache, the part of it no
 * image shares (all a prune can free), and the workspace images sealant's worker keeps.
 */
export const describeUsage = (listing) => {
  const sum = (items) => items.reduce((total, item) => total + item.size, 0);
  const workspace = (listing?.images ?? []).filter(isWorkspace);
  return [
    listing?.cache
      ? `build cache ${gib(sum(listing.cache))} in ${listing.cache.length} records (${gib(sum(listing.cache.filter((record) => !record.shared)))} not shared with an image)`
      : "build cache unknown",
    `workspace images ${gib(sum(workspace))} in ${workspace.length}`,
  ].join(", ");
};

/** One line for a step's detail: what the choice removes. */
export const describeTidy = (choice) => {
  if (choice.refused) return `nothing removed: ${choice.refused}`;
  const sum = (items) => items.reduce((total, item) => total + item.size, 0);
  const parts = [
    choice.images.length > 0
      ? `${choice.images.length} images (${gib(sum(choice.images))}): ${choice.images.map((image) => image.ref.replace(/^sha256:([0-9a-f]{12})[0-9a-f]+$/, "sha256:$1")).join(", ")}`
      : "no images",
    choice.cache.length > 0
      ? `${choice.cache.length} build cache records unused for ${CACHE_UNUSED_HOURS} h (${gib(sum(choice.cache))}, ${gib(sum(choice.cache.filter((record) => !record.shared)))} of it not shared with an image, which is what removing them frees)`
      : "no build cache",
    choice.dumps.length > 0
      ? `${choice.dumps.length} dumps (${gib(sum(choice.dumps))}): ${choice.dumps.map((dump) => dump.path.slice(BACKUPS.length + 1)).join(", ")}`
      : "no dumps",
  ];
  return parts.join("; ");
};

const quote = (text) => `'${text}'`;

/**
 * The removal script for a choice: it refuses unless the hold file still names `tag` (for a deploy,
 * unless the hold file is still what it was when the choice was made: `holdSha`, the sha256 of its
 * contents, empty when there was none), and removes only what the choice lists. `docker image rm`
 * without -f, so Docker itself refuses an image a container uses.
 */
export const tidyScript = (choice, tag, { holdSha } = {}) => {
  if (!SAFE_TAG.test(tag)) throw new Error(`refusing to tidy for an unexpected tag ${tag}`);
  if (tag === DEPLOY_TAG && !/^[0-9a-f]{64}$/.test(holdSha ?? ""))
    throw new Error("a deploy's tidy needs the sha256 of the hold file it chose with");
  const lines = [
    "set -u",
    tag === DEPLOY_TAG
      ? `[ "$(cat ${HOLD} 2>/dev/null | sha256sum | cut -c1-64)" = '${holdSha}' ] || { echo "refused=a check took the box's hold since the choice"; exit 9; }`
      : `grep -q '"tag":"${tag}"' ${HOLD} 2>/dev/null || { echo "refused=the hold is not ${tag}'s"; exit 9; }`,
    `echo "before=$(df -B1 --output=avail /var/lib/docker | tail -1 | tr -d ' ')"`,
  ];
  for (const image of choice.images) {
    if (!SAFE_REFERENCE.test(image.ref)) continue;
    lines.push(
      `if out=$(docker image rm ${quote(image.ref)} 2>&1); then echo "removed=image|${image.ref}"; else echo "failed=image|${image.ref}|$(printf '%s' "$out" | tail -1)"; fi`,
    );
  }
  if (choice.cache.length > 0)
    lines.push(
      `if out=$(docker buildx prune --all --force --filter until=${CACHE_UNUSED_HOURS}h 2>&1); then echo "pruned=$(printf '%s' "$out" | tail -1)"; else echo "failed=cache|buildx prune|$(printf '%s' "$out" | tail -1)"; fi`,
      `echo "cacheafter=$(curl -sf --unix-socket /var/run/docker.sock 'http://localhost/system/df?type=build-cache' | tr -d '\\n')"`,
    );
  for (const dump of choice.dumps) {
    if (!SAFE_DUMP.test(dump.path)) continue;
    lines.push(
      `if rm -f -- ${quote(dump.path)}; then echo "removed=dump|${dump.path}"; else echo "failed=dump|${dump.path}"; fi`,
    );
  }
  lines.push(`echo "after=$(df -B1 --output=avail /var/lib/docker | tail -1 | tr -d ' ')"`);
  return lines.join("\n");
};

/**
 * Reads tidyScript's output into what was removed, what failed and free space before and after.
 * Build cache removed is every record of the listing that is gone afterwards.
 */
export const parseTidyRun = (text, listing) => {
  const removed = { images: [], cache: [], dumps: [] };
  const failed = [];
  let before = null;
  let after = null;
  let refused = null;
  let cacheAfter = null;
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (key === "before" && /^\d+$/.test(value)) before = Number(value);
    else if (key === "after" && /^\d+$/.test(value)) after = Number(value);
    else if (key === "refused") refused = value;
    else if (key === "removed") {
      const [kind, ref] = value.split("|");
      if (kind === "image") removed.images.push(ref);
      if (kind === "dump") removed.dumps.push(ref);
    } else if (key === "failed") {
      const [kind, ref, ...why] = value.split("|");
      failed.push({ kind, ref, why: why.join("|") });
    } else if (key === "cacheafter") {
      const records = json(value, null)?.BuildCache;
      if (Array.isArray(records)) cacheAfter = new Set(records.map((record) => record.ID));
    }
  }
  if (cacheAfter !== null)
    removed.cache = (listing.cache ?? [])
      .filter((record) => !cacheAfter.has(record.id))
      .map((record) => record.id);
  return { before, after, refused, removed, failed };
};

/** What a run removed of a choice, from parseTidyRun's names, with sizes for describeTidy. */
export const goneOf = (choice, run, listing) => ({
  images: choice.images.filter((image) => run.removed.images.includes(image.ref)),
  cache: (listing.cache ?? []).filter((record) => run.removed.cache.includes(record.id)),
  dumps: choice.dumps.filter((dump) => run.removed.dumps.includes(dump.path)),
});

const say = (line) => process.stdout.write(`preview-deploy: tidy: ${line}\n`);

/**
 * On the box, as root, after a preview deploy (scripts/preview-deploy.sh): lists the box, chooses
 * with chooseDeployTidy and removes exactly that. Prints one `tidy: …` line; never throws, so a tidy
 * that fails leaves the deploy as it stood.
 */
const deployTidy = async (commit, startedAt) => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const bash = (script) =>
    execFileSync("bash", ["-c", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try {
    const listing = parseListing(bash(LIST_BOX));
    let text = "";
    try {
      text = readFileSync(HOLD, "utf8");
    } catch {
      // No hold.
    }
    const hold = text === "" ? null : json(text, { unreadable: text.slice(0, 80) });
    const choice = chooseDeployTidy({ listing, hold, commit, startedAt });
    if (choice.refused) return say(`nothing removed: ${choice.refused}`);
    if (choice.images.length + choice.cache.length + choice.dumps.length === 0)
      return say(
        `nothing to remove; ${listing.free === null ? "free space unknown" : `${gib(listing.free)} free`}`,
      );
    const holdSha = createHash("sha256").update(text).digest("hex");
    let out = "";
    try {
      out = bash(tidyScript(choice, DEPLOY_TAG, { holdSha }));
    } catch (error) {
      out = String(error.stdout ?? "");
    }
    const run = parseTidyRun(out, listing);
    say(
      [
        run.refused
          ? `refused: ${run.refused}`
          : `removed ${describeTidy(goneOf(choice, run, listing))}`,
        ...run.failed.map((failure) => `could not remove ${failure.ref}: ${failure.why}`),
        `free ${run.before === null ? "unknown" : gib(run.before)} before, ${run.after === null ? "unknown" : gib(run.after)} after`,
      ].join("; "),
    );
  } catch (error) {
    const why =
      error.status === undefined ? String(error.message ?? error) : `bash exited ${error.status}`;
    say(`failed, the deploy stands: ${why.split("\n")[0]}`);
  }
};

if (process.argv[2] === "deploy" && import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await deployTidy(process.argv[3], process.argv[4]);
