#!/usr/bin/env node
/**
 * Deletes image.yml's staging tags that no release finalized: package versions on GHCR whose
 * every tag is `staging-<run>-<attempt>` and that have not changed for 14 days.
 * (.github/workflows/ghcr-staging-cleanup.yml; docs/operations/next-channel.md.)
 *
 *   GITHUB_TOKEN=… node scripts/ghcr-staging-cleanup.mjs [--delete]
 *
 * Without --delete it only lists. A version is kept when it has no tag (a platform manifest or an
 * attestation an index points at), when any tag is not a staging tag (a final version, dev,
 * acceptance or `latest` beside a staging tag), or when it is younger than 14 days by `updated_at`,
 * which GitHub moves forward whenever the version's tags change. Any API error, a 403 included,
 * fails the run: nothing is guessed.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGES = ["mend", "mend-api", "mend-web"];
export const MIN_AGE_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

/** Whether `version` (one entry of the versions API) may be deleted, and why not when it may not. */
export function classify(version, now) {
  const tags = version.metadata?.container?.tags ?? [];
  if (tags.length === 0) return { candidate: false, reason: "untagged: a platform manifest" };
  const kept = tags.filter((tag) => !tag.startsWith("staging-"));
  if (kept.length > 0) return { candidate: false, reason: `carries ${tags.join(", ")}` };
  const updated = Date.parse(version.updated_at);
  if (!Number.isFinite(updated)) throw new Error(`version ${version.id} has no updated_at`);
  const days = Math.floor((now - updated) / DAY);
  if (now - updated < MIN_AGE_DAYS * DAY)
    return { candidate: false, reason: `staging only, ${days} days old (< ${MIN_AGE_DAYS})` };
  return { candidate: true, reason: `staging only, ${days} days old` };
}

/** A GitHub REST request; anything but the expected status throws, with what GitHub said. */
async function request(api, token, method, url, expected) {
  const response = await fetch(new URL(url, api), {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response.status !== expected) {
    const body = (await response.text()).slice(0, 500);
    const hint =
      response.status === 403
        ? " The workflow token may not administer this package (Manage Actions access)."
        : "";
    throw new Error(`${method} ${url} answered ${response.status}: ${body}.${hint}`);
  }
  return response;
}

/** Every version of a container package, following the API's Link pagination. */
async function versionsOf(api, token, org, name) {
  const versions = [];
  let next = `/orgs/${org}/packages/container/${name}/versions?per_page=100`;
  while (next !== undefined) {
    const response = await request(api, token, "GET", next, 200);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`GET ${next} did not answer a list`);
    versions.push(...page);
    next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
  }
  return versions;
}

/** Lists, and with `remove` deletes, every package's candidates; returns the report lines. */
export async function cleanup({
  api = "https://api.github.com",
  token,
  org = "sealant-sh",
  packages = PACKAGES,
  now = Date.now(),
  remove = false,
  log = console.log,
}) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const deleted = [];
  for (const name of packages) {
    for (const version of await versionsOf(api, token, org, name)) {
      const { candidate, reason } = classify(version, now);
      const tags = version.metadata?.container?.tags ?? [];
      const label = `${name} ${version.id} [${tags.join(", ")}]`;
      if (!candidate) {
        log(`KEEP ${label}: ${reason}`);
        continue;
      }
      if (!remove) {
        log(`CANDIDATE ${label}: ${reason}`);
        continue;
      }
      await request(
        api,
        token,
        "DELETE",
        `/orgs/${org}/packages/container/${name}/versions/${version.id}`,
        204,
      );
      deleted.push(`${name}/${version.id}`);
      log(`DELETED ${label}: ${reason}`);
    }
  }
  return deleted;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--delete")) {
    console.error("usage: node scripts/ghcr-staging-cleanup.mjs [--delete]");
    process.exit(2);
  }
  cleanup({
    api: process.env.GITHUB_API_URL || undefined,
    token: process.env.GITHUB_TOKEN,
    remove: args.includes("--delete"),
  }).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
