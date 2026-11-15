import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, join, matchesGlob, relative } from "node:path";

import { parse } from "yaml";

// The tests `verify check` lets skip, and why. tooling/verify/allowed-skips.json lists each with
// its gate and where it does run, in one of two kinds:
// - `ci`: a CI job and step set the gate. ciGateProblems holds that claim to ci.yml, so the list
//   cannot keep naming a step that stopped running the test.
// - `local-only`: nothing in CI runs it; it runs only where `where` says. It is allowed so that a
//   machine without that data can pass, and the receipt names it as running in no CI job.
// An entry with `test` covers only the tests whose full name contains it.
// A skip the list does not name, or one whose gate the change owes, leaves `check` skipped.

export const ALLOWED_SKIPS = "tooling/verify/allowed-skips.json";

export const loadAllowedSkips = (root) =>
  JSON.parse(readFileSync(join(root, ALLOWED_SKIPS), "utf8")).allowed;

/** Every way the list departs from its shape; empty when it is usable. */
export const validateAllowedSkips = (entries) =>
  entries.flatMap((entry, index) => {
    const at = `allowed[${index}] (${entry.file ?? "no file"})`;
    const errors = [];
    for (const key of ["file", "gate", "reason", "kind"])
      if (typeof entry[key] !== "string" || entry[key] === "")
        errors.push(`${at}.${key} is required`);
    if (entry.kind === "ci") {
      for (const key of ["job", "step"])
        if (typeof entry[key] !== "string" || entry[key] === "")
          errors.push(`${at}: a ci skip names the CI ${key} that sets its gate`);
    } else if (entry.kind === "local-only") {
      if (typeof entry.where !== "string" || entry.where === "")
        errors.push(`${at}: a local-only skip says where it runs`);
    } else if (entry.kind !== undefined) {
      errors.push(`${at}.kind ${entry.kind} is not ci or local-only`);
    }
    return errors;
  });

/** Where an allowed skip runs, as the receipt says it. */
export const whereOf = (entry) =>
  entry.kind === "ci" ? `CI ${entry.job} (${entry.step})` : `no CI job, only ${entry.where}`;

const SKIPPED = new Set(["pending", "skipped", "todo", "disabled"]);

/** Every test the reports say did not run, as { name, file, test }. */
export const readSkips = (root, reportDir) => {
  if (!existsSync(reportDir)) return [];
  const skips = [];
  for (const name of readdirSync(reportDir)
    .filter((file) => file.endsWith(".json"))
    .toSorted()) {
    const report = JSON.parse(readFileSync(join(reportDir, name), "utf8"));
    for (const file of report.testResults ?? []) {
      // A failed file's hook failure marks its tests skipped; the failure is the finding there.
      if (file.status === "failed") continue;
      const path = relative(root, file.name ?? "");
      for (const test of file.assertionResults ?? []) {
        if (SKIPPED.has(test.status))
          skips.push({ name: `${path} > ${test.fullName}`, file: path, test: test.fullName });
      }
    }
  }
  return skips;
};

const entryFor = (skip, allowed) =>
  allowed.find(
    (candidate) =>
      matchesGlob(skip.file, candidate.file) &&
      (candidate.test === undefined || (skip.test ?? "").includes(candidate.test)),
  );

/**
 * Splits skips into those the checked-in list allows here and those it does not. An allowed
 * skip stops being allowed when this change owes its gate (the plan names it), because then the
 * suite is the evidence the change needs. `ciJobs` is the plan's CI jobs, so a ci skip says
 * whether its job runs for this change.
 */
export const judgeSkips = (skips, allowed, owedGates, ciJobs = []) =>
  skips.map(({ test, ...skip }) => {
    const entry = entryFor({ ...skip, test }, allowed);
    if (entry === undefined) return { ...skip, allowed: false };
    const owed = owedGates.includes(entry.gate);
    const job =
      entry.kind === "ci" ? ciJobs.find((candidate) => candidate.job === entry.job) : null;
    return {
      ...skip,
      gate: entry.gate,
      allowed: !owed,
      reason: owed ? `this change owes ${entry.gate}` : entry.reason,
      ...(entry.kind ? { kind: entry.kind, where: whereOf(entry) } : {}),
      ...(job ? { ciRunsForThisChange: job.runs } : {}),
    };
  });

/**
 * One sentence for the receipt: how many tests skipped here and where each group runs.
 * Empty when nothing skipped.
 */
export const summarizeSkips = (skipped) => {
  if (skipped.length === 0) return "";
  const unallowed = skipped.filter((skip) => !skip.allowed).length;
  const groups = new Map();
  for (const skip of skipped.filter((candidate) => candidate.allowed)) {
    const where = skip.where ?? "allowed here";
    const note = skip.ciRunsForThisChange === false ? ", a job this change does not select" : "";
    const key = `${where}${note}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const parts = [...groups].map(([where, count]) => `${count} in ${where}`);
  const head = `${skipped.length} ${skipped.length === 1 ? "test" : "tests"} skipped here`;
  return `${head}${unallowed > 0 ? `, ${unallowed} not allowed` : ", all allowed"}${
    parts.length > 0 ? `: ${parts.join("; ")}` : ""
  }`;
};

// A gate this machine can set safely when the tool it names is installed. Each test it opens runs
// offline against throwaway files; none takes a credential or reaches a service. CI sets none of
// these: the runners lack the tools.
export const LOCAL_GATES = [
  {
    gate: "MEND_TEST_DOPPLER_BINARY",
    binary: "doppler",
    file: "packages/sessions/test/doppler-helper.test.ts",
    why: "the real Doppler CLI reads a scoped YAML with a fake token, offline",
    install: "nix profile install nixpkgs#doppler",
  },
];

const onPath = (binary, path) => {
  for (const directory of (path ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next directory.
    }
  }
  return null;
};

/** The local gates to set for this run, from the tools on PATH; a gate already set is kept. */
export const localGates = (env) =>
  LOCAL_GATES.flatMap((gate) => {
    if (env[gate.gate] !== undefined) return [];
    const found = onPath(gate.binary, env.PATH);
    return found === null ? [] : [{ ...gate, value: found }];
  });

/** For an unallowed skip a local gate would run: what to install. */
export const installHint = (skip) => {
  const gate = LOCAL_GATES.find((candidate) => candidate.file === skip.file);
  return gate
    ? `${gate.install}  # then verify check sets ${gate.gate} from the ${gate.binary} on PATH`
    : null;
};

// The script a step's command runs: `node <file>`, or `pnpm [run] <script>` through package.json.
const scriptsOf = (root, command, depth = 0) => {
  const files = [];
  for (const match of command.matchAll(/(?:^|\s)node\s+(?:--\S+\s+)*([\w./-]+\.m?[jt]s)\b/g))
    files.push(match[1]);
  const pnpm = /(?:^|\s)pnpm\s+(?:run\s+)?([\w:-]+)/.exec(command);
  if (pnpm && depth === 0) {
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
    if (scripts[pnpm[1]] !== undefined) files.push(...scriptsOf(root, scripts[pnpm[1]], 1));
  }
  return files;
};

// apps/<app>/… and packages/<package>/…: a runner names the file from inside its package.
const inPackage = (file) => file.split("/").slice(2).join("/");

/**
 * Each `ci` skip's claim, checked against the workflow: its job and step exist, and the step sets
 * the gate (in its own or its job's env, or in the script its command runs, which also names the
 * test file). Returns what no longer holds.
 */
export const ciGateProblems = (root, entries, workflow = ".github/workflows/ci.yml") => {
  const jobs = parse(readFileSync(join(root, workflow), "utf8")).jobs ?? {};
  return entries
    .filter((entry) => entry.kind === "ci")
    .flatMap((entry) => {
      const at = `${entry.file} (${entry.gate})`;
      const job = jobs[entry.job];
      if (job === undefined) return [`${at}: ${workflow} has no job ${entry.job}`];
      const step = (job.steps ?? []).find((candidate) => candidate.name === entry.step);
      if (step === undefined) return [`${at}: job ${entry.job} has no step "${entry.step}"`];
      if (Object.hasOwn(step.env ?? {}, entry.gate) || Object.hasOwn(job.env ?? {}, entry.gate))
        return [];
      const scripts = scriptsOf(root, String(step.run ?? ""));
      if (scripts.length === 0)
        return [`${at}: step "${entry.step}" sets no env and runs no script to read`];
      const sources = scripts.map((file) => readFileSync(join(root, file), "utf8"));
      const sets = sources.some(
        (source) =>
          new RegExp(`\\b${entry.gate}\\b`).test(source) && source.includes(inPackage(entry.file)),
      );
      return sets
        ? []
        : [
            `${at}: step "${entry.step}" (${scripts.join(", ")}) no longer sets the gate for this file`,
          ];
    });
};
