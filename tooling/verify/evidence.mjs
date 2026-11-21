import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { readFrontRun } from "./box-front.mjs";
import { rollUp } from "./result.mjs";
import { readRun, run as runCommand, runEnv } from "./stack.mjs";

// `verify evidence`: for the current head, gather what `verify drive` produced, run the secret scan
// over the stack run's evidence, and write the verdict file a PR comment starts from
// (.verify/evidence/<sha12>/verdict.md). It reports what was captured and what was not; the
// observations, and any verdict, are the person's or the checking agent's to write.

const SKILL = ".agents/skills/verify";

/** This head's drive results, clean tree only, newest first per surface and recipe. */
export const driveResults = (root, head) => {
  const dir = join(root, ".verify/results");
  if (!existsSync(dir)) return [];
  const seen = new Set();
  return readdirSync(dir)
    .filter((name) => name.startsWith("drive-") && name.endsWith(".json"))
    .toSorted()
    .toReversed()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
    .filter((result) => result.head.sha === head.sha && !result.head.dirty)
    .filter((result) => {
      const key = result.verb;
      const drove = result.drive
        ? `${result.drive.surface}${result.drive.box ? "@box" : ""}/${result.drive.recipe}`
        : key;
      if (seen.has(drove)) return false;
      seen.add(drove);
      return true;
    });
};

/** Sorts a drive's output directory by what each file is. */
export const artifacts = (dir) => {
  const found = { screenshots: [], withheld: [], snapshots: [], transcripts: [], failures: [] };
  if (!existsSync(dir)) return found;
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.startsWith("failure-")) found.failures.push(path);
      else if (entry.name.endsWith(".png") && existsSync(`${path}.checked`))
        found.screenshots.push(path);
      else if (entry.name.endsWith(".png.withheld")) found.withheld.push(path);
      else if (entry.name.endsWith(".aria.yml")) found.snapshots.push(path);
      else if (/\.(log|stdout|stderr|cmd|exit|jsonl|txt)$/.test(entry.name))
        found.transcripts.push(path);
    }
  };
  walk(dir);
  for (const list of Object.values(found)) list.sort();
  return found;
};

const scanHits = (dir) => {
  const path = join(dir, "scan.json");
  if (!existsSync(path)) return null;
  const scan = JSON.parse(readFileSync(path, "utf8"));
  const hits = scan.hits ?? [];
  return Array.isArray(hits) ? hits.length : Object.keys(hits).length;
};

export const evidence = async (
  root,
  { head, env = process.env, exec = runCommand, statusLines = [], judgement = null },
) => {
  const drives = driveResults(root, head);
  if (drives.length === 0) {
    return {
      steps: [
        {
          id: "drives",
          title: "Drives of this head",
          status: "skipped",
          detail: `no verify drive result for ${head.sha.slice(0, 12)} with a clean tree`,
        },
      ],
      next: ["pnpm verify drive web --recipe <recipe>"],
    };
  }
  const steps = [];
  steps.push({
    id: "drives",
    title: "Drives of this head",
    status: rollUp(drives.map((result) => result.status)),
    detail: drives
      .map((result) =>
        `${result.verb.slice("drive ".length)} ${result.drive?.recipe ?? ""}: ${result.status}`.trim(),
      )
      .join("; "),
  });

  // The scan: the stack run's registry while it lives, else the scan `stack down` left; VS Code
  // worlds scan their own evidence when they come down.
  const state = readRun(root);
  const onStack = drives.filter(
    (result) => result.drive && result.drive.surface !== "vscode" && !result.drive.box,
  );
  if (onStack.length > 0) {
    if (state && existsSync(state.private)) {
      const scan = await exec(
        "node",
        [
          join(root, SKILL, "scripts/scan-evidence.mjs"),
          "--dir",
          state.evidence,
          "--secrets",
          state.private,
          "--delete-hits",
        ],
        { cwd: root, env: runEnv(root, env, state), log: join(state.evidence, "scan.log") },
      );
      steps.push({
        id: "scan",
        title: "Secret scan of the stack run's evidence",
        status: scan.code === 0 ? "passed" : scan.code === 1 ? "evidence_withheld" : "failed",
        log: join(state.evidence, "scan.json"),
        detail:
          scan.code === 0
            ? "no hit"
            : scan.code === 1
              ? "hits: those files are deleted (scan.json names them)"
              : `scan exited ${scan.code}`,
      });
    } else {
      const hits = state ? scanHits(state.evidence) : null;
      steps.push({
        id: "scan",
        title: "Secret scan of the stack run's evidence",
        status:
          hits === null ? "blocked_by_prerequisite" : hits === 0 ? "passed" : "evidence_withheld",
        detail:
          hits === null
            ? "the run's registry is gone and it left no scan.json"
            : `stack down's scan: ${hits} hits`,
      });
    }
  }
  // The web app on the box: its own registry while it lives, else the scan `box release` left.
  const front = readFrontRun(root);
  const onBox = drives.filter((result) => result.drive?.box);
  if (onBox.length > 0) {
    const dir = front?.evidence ?? join(onBox[0].drive.out, "../..");
    if (front && existsSync(front.private)) {
      const scan = await exec(
        "node",
        [
          join(root, SKILL, "scripts/scan-evidence.mjs"),
          "--dir",
          front.evidence,
          "--secrets",
          front.private,
          "--delete-hits",
        ],
        { cwd: root, env, log: join(front.evidence, "scan.log") },
      );
      steps.push({
        id: "scan-box",
        title: "Secret scan of the box check's evidence",
        status: scan.code === 0 ? "passed" : scan.code === 1 ? "evidence_withheld" : "failed",
        log: join(front.evidence, "scan.json"),
        detail:
          scan.code === 0
            ? "no hit"
            : scan.code === 1
              ? "hits: those files are deleted (scan.json names them)"
              : `scan exited ${scan.code}`,
      });
    } else {
      const hits = scanHits(dir);
      steps.push({
        id: "scan-box",
        title: "Secret scan of the box check's evidence",
        status:
          hits === null ? "blocked_by_prerequisite" : hits === 0 ? "passed" : "evidence_withheld",
        detail:
          hits === null
            ? "the box check's registry is gone and it left no scan.json"
            : `box release's scan: ${hits} hits`,
      });
    }
  }
  const worlds = drives.filter((result) => result.drive?.surface === "vscode");
  if (worlds.length > 0) {
    const dirs = [...new Set(worlds.map((result) => join(result.drive.out, "..")))];
    const hits = dirs.map(scanHits);
    steps.push({
      id: "scan-vscode",
      title: "Secret scan of the VS Code world's evidence",
      status: hits.some((count) => count === null)
        ? "skipped"
        : hits.every((count) => count === 0)
          ? "passed"
          : "evidence_withheld",
      detail: hits.some((count) => count === null)
        ? "drive-vscode.mjs down scans its evidence; run it, then this again"
        : `${hits.reduce((a, b) => a + (b ?? 0), 0)} hits`,
    });
  }

  const sections = drives.map((result) => {
    const found = result.drive ? artifacts(result.drive.out) : null;
    const where = result.drive ? result.drive.out : "";
    return { result, found, where };
  });
  const doctor =
    state && existsSync(join(state.evidence, "doctor/doctor.txt"))
      ? readFileSync(join(state.evidence, "doctor/doctor.txt"), "utf8")
      : "";
  const buildLines = [
    ...doctor
      .split("\n")
      .filter((line) => /^(ok|NOT)\s+(web version|mend at|sealant at|sealantd at)/.test(line)),
    ...[...new Set(onBox.map((result) => JSON.stringify(result.drive.box)))].map((text) => {
      const box = JSON.parse(text);
      return `the box ${box.web} runs ${box.version}, revision ${box.revision}; the web app from this checkout`;
    }),
  ];
  const verdictDir = join(root, ".verify/evidence", head.sha.slice(0, 12));
  mkdirSync(verdictDir, { recursive: true });
  const verdict = join(verdictDir, "verdict.md");
  const scanStep = steps.filter((step) => step.id.startsWith("scan"));
  writeFileSync(
    verdict,
    [
      `**Checked:** head \`${head.sha}\` (${head.branch}), clean tree.`,
      "",
      "**Build:**",
      ...(buildLines.length > 0
        ? buildLines.map((line) => `- ${line.replace(/\s+/g, " ")}`)
        : ["- (no doctor record for this run)"]),
      "",
      "**Driven:**",
      ...sections.map(({ result, found, where }) =>
        found
          ? `- ${result.drive.surface}${result.drive.box ? " on the box" : ""} · \`${result.drive.recipe}\` · ${result.status} · ${found.screenshots.length} screenshots (${found.withheld.length} withheld), ${found.snapshots.length} ARIA snapshots, ${found.transcripts.length} transcripts${found.failures.length ? `, ${found.failures.length} failure captures` : ""} · \`${where}\``
          : `- ${result.verb} · ${result.status}`,
      ),
      "",
      ...(judgement
        ? [
            "**What I saw:** (under each thing the judge asked for, what you did, what you saw and its evidence)",
            "",
            ...judgement.mustSee.map((line) => `- ${line}`),
            `- If it did not work: ${judgement.ifBroken}`,
          ]
        : [
            "**What I saw:** (write the observations here: the action, its result, and the side effect seen a second time)",
          ]),
      "",
      "**Secret scan:**",
      ...scanStep.map((step) => `- ${step.title}: ${step.status} (${step.detail})`),
      "",
      ...(statusLines.length > 0 ? ["**Obligations:**", ...statusLines, ""] : []),
      "**Not checked:** (say what was not reached, and why)",
      "",
    ].join("\n"),
  );
  steps.push({
    id: "verdict",
    title: "Write the verdict file",
    status: "passed",
    log: relative(root, verdict),
  });
  return {
    steps,
    next: [],
    evidence: [
      { kind: "verdict", path: relative(root, verdict) },
      ...sections.flatMap(({ found }) =>
        found ? found.screenshots.map((path) => ({ kind: "screenshot", path })) : [],
      ),
    ],
  };
};
