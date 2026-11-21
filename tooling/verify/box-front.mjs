import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { changedFiles, filesOwing, loadMap } from "./plan.mjs";

// The web app on the box (SLNT-1120). A change that is only the web app needs no preview of its
// own: `verify drive web --box` serves the app from this checkout with `vite dev`, behind the local
// proxy a stack drive uses, in front of the box's API: the proxy gives every /api request the
// box's own Origin, so the box's allowed origins stay as they are, and the session cookie the box
// sets is for the host the browser used (localhost). Nothing on the box changes.
//
// This module holds what the drive, `verify evidence` and the box verbs share: which paths the
// checkout serves (FRONT), the box run's local record (.verify/box/front.json, with its private
// directory of credentials and its evidence directory), and whether a change is the front's alone,
// which is when `box identity` accepts a box that does not run this head.

/** What `drive web --box` serves from the checkout: the web app and the kit only it uses. */
export const FRONT = ["apps/web/", "packages/ui/"];

const inFront = (file) => FRONT.some((prefix) => file.startsWith(prefix));

const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

/** One read of the box over ssh: its APP_URL, the build it runs and whether Mend is running. */
export const READ_FRONT = `
set -u
label() { docker inspect --format "{{index .Config.Labels \\"$1\\"}}" mend-mend-1 2>/dev/null; }
echo "version=$(label org.opencontainers.image.version)"
echo "revision=$(label org.opencontainers.image.revision)"
echo "running=$(docker inspect --format '{{.State.Running}}' mend-mend-1 2>/dev/null)"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' mend-mend-1 2>/dev/null | grep '^APP_URL='
`;

/** Parses READ_FRONT's output; missing values are null. */
export const parseFront = (text) => {
  const values = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1).trim() || null;
  }
  return {
    version: values.version ?? null,
    revision: /^[0-9a-f]{40}$/.test(values.revision ?? "") ? values.revision : null,
    appUrl: values.APP_URL ?? null,
    running: values.running === "true",
  };
};

const recordPath = (root) => join(root, ".verify/box/front.json");

/** The box run of the web app this checkout recorded, or null. */
export const readFrontRun = (root) =>
  existsSync(recordPath(root)) ? JSON.parse(readFileSync(recordPath(root), "utf8")) : null;

/** The box account the drive signs in as: the daily box run's checker account unless named. */
export const boxAccount = (env) => ({
  email: env.MEND_VERIFY_BOX_EMAIL || "boat-check@example.test",
  passwordFile:
    env.MEND_VERIFY_BOX_PASSWORD_FILE ||
    join(env.HOME || homedir(), ".local/share/mend-boat-check/password"),
});

/**
 * Starts, or takes up again, this checkout's box run, under
 * ${XDG_STATE_HOME:-~/.local/state}/mend-verify/box-<checkout directory>: one private directory
 * (mode 700) holding the account's sign-in for the web driver, its browser state and the run's
 * secret registry, and the evidence of each head under evidence/<sha12>. One private directory per
 * checkout, so a later commit's drive takes it up again rather than leaving the last one behind.
 * The password is read only into the private account file.
 */
export const startFrontRun = (root, { head, box, env }) => {
  const base = join(
    env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local/state"),
    "mend-verify",
    `box-${basename(root)}`,
  );
  const account = boxAccount(env);
  if (!existsSync(account.passwordFile))
    return { error: `no password file at ${account.passwordFile} (MEND_VERIFY_BOX_PASSWORD_FILE)` };
  const run = {
    head: head.sha,
    web: box.appUrl,
    revision: box.revision,
    version: box.version,
    private: join(base, "private"),
    evidenceRoot: join(base, "evidence"),
    evidence: join(base, "evidence", head.sha.slice(0, 12)),
  };
  mkdirSync(run.private, { recursive: true, mode: 0o700 });
  chmodSync(run.private, 0o700);
  mkdirSync(run.evidence, { recursive: true });
  const password = readFileSync(account.passwordFile, "utf8").replace(/\n$/, "");
  writeFileSync(
    join(run.private, "account.json"),
    JSON.stringify({ email: account.email, password }),
    { mode: 0o600 },
  );
  mkdirSync(join(root, ".verify/box"), { recursive: true });
  writeFileSync(recordPath(root), `${JSON.stringify(run, null, 2)}\n`);
  return { run };
};

/** Removes the box run's private directory and its record; its evidence stays. */
export const endFrontRun = (root) => {
  const run = readFrontRun(root);
  if (run === null) return null;
  rmSync(run.private, { recursive: true, force: true });
  rmSync(recordPath(root), { force: true });
  return run;
};

/**
 * Whether this head's change is the front's alone, and whether the box's server is one it can be
 * checked against: the change's product source (the files that owe a judgement) is all under
 * FRONT, and the product source outside FRONT is the same at the box's revision as at this head,
 * or the box's revision has this head's merge base in its history (a server at or after this
 * branch's base). Null fields mean the check does not apply (no change, no revision).
 */
export const frontOnly = (root, { head, revision }) => {
  const map = loadMap(root);
  const product =
    head.mergeBase === null ? [] : filesOwing(map, changedFiles(root, head.mergeBase), "judge");
  const outside = product.filter((file) => !inFront(file));
  if (product.length === 0 || outside.length > 0)
    return { front: false, product, outside, server: null };
  if (revision === null) return { front: true, product, outside, server: null };
  const differs = filesOwing(
    map,
    git(root, ["diff", "--no-renames", "--name-only", revision, head.sha])
      .split("\n")
      .filter(Boolean),
    "judge",
  ).filter((file) => !inFront(file));
  if (differs.length === 0) return { front: true, product, outside, server: "same" };
  try {
    git(root, ["merge-base", "--is-ancestor", head.mergeBase, revision]);
    return { front: true, product, outside, server: "later", differs };
  } catch {
    return { front: true, product, outside, server: "other", differs };
  }
};

/** A line saying what frontOnly found, for plan and identity. */
export const describeFront = (found, revision) => {
  const at = revision?.slice(0, 12) ?? "unknown";
  if (!found.front)
    return found.product.length === 0
      ? "this change has no product source"
      : `this change's product source reaches past the web app (${found.outside.slice(0, 3).join(", ")}${found.outside.length > 3 ? ", …" : ""}): the box must run a preview of this head`;
  return (
    {
      same: `the box runs ${at}, whose server source is this head's outside the web app`,
      later: `the box runs ${at}, which has this branch's base in its history`,
      other: `the box runs ${at}, whose server source differs from this branch's base (${found.differs?.slice(0, 3).join(", ")}${(found.differs?.length ?? 0) > 3 ? ", …" : ""}): deploy a preview of main or of this head`,
    }[found.server] ?? "the box reports no revision"
  );
};
