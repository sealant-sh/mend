import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Reads docs/formal/<area>/COVERAGE: what code each model stands for, which of its own files are
// the model, and the commit whose code it was last confirmed to describe. The one reader for
// scripts/ci-scope.mjs (the `formal` lane), `verify plan` and `verify formal`, so the CI job, the
// plan and the drift guard cannot disagree. No dependency: the `changes` job runs it before any
// install.
//
//   sync <full commit id>
//   model <file in the area's directory>      (a change to one is a change to the model)
//   path <repository path>                    (code the model stands for)
//   budget-quick <minutes>                    (optional: how long `check.sh --quick` may run)
//   budget-full <minutes>                     (optional: how long `check.sh` may run, on CI's
//                                              four-core runner; past it the check is stopped)

/** The budgets an area without its own gets, in minutes. */
export const defaultBudgets = { quick: 10, full: 40 };

export const parseCoverage = (text, area) => {
  const coverage = {
    area,
    dir: `docs/formal/${area}`,
    sync: null,
    model: [],
    paths: [],
    budgets: { ...defaultBudgets },
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [key, value, ...rest] = line.split(/\s+/);
    if (value === undefined || rest.length > 0)
      throw new Error(`${area}/COVERAGE: cannot read "${line}"`);
    if (key === "sync") {
      if (!/^[0-9a-f]{40}$/.test(value))
        throw new Error(`${area}/COVERAGE: sync must be a full commit id`);
      coverage.sync = value;
    } else if (key === "model") coverage.model.push(`${coverage.dir}/${value}`);
    else if (key === "path") coverage.paths.push(value);
    else if (key === "budget-quick" || key === "budget-full") {
      if (!/^[1-9][0-9]*$/.test(value))
        throw new Error(`${area}/COVERAGE: ${key} must be a whole number of minutes`);
      coverage.budgets[key === "budget-quick" ? "quick" : "full"] = Number(value);
    } else throw new Error(`${area}/COVERAGE: unknown key ${key}`);
  }
  if (coverage.sync === null || coverage.model.length === 0 || coverage.paths.length === 0)
    throw new Error(`${area}/COVERAGE needs a sync, a model and a path`);
  return coverage;
};

/** Every area under docs/formal with a COVERAGE file. */
export const readCoverages = (root) => {
  const base = join(root, "docs/formal");
  let areas = [];
  try {
    areas = readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  return areas.flatMap((entry) => {
    let text;
    try {
      text = readFileSync(join(base, entry.name, "COVERAGE"), "utf8");
    } catch {
      return [];
    }
    return [parseCoverage(text, entry.name)];
  });
};

export const coverageFile = (coverage) => `${coverage.dir}/COVERAGE`;

/**
 * Files every model is checked with: docs/formal/tlx.sh pins and builds the checker. A change to
 * one is a change to every model, so each is checked again.
 */
export const sharedModelFiles = ["docs/formal/tlx.sh"];

/** Whether a changed path is code the model covers, the model itself, its COVERAGE or its checker. */
export const touches = (coverage, path) =>
  coverage.paths.includes(path) ||
  coverage.model.includes(path) ||
  path === coverageFile(coverage) ||
  sharedModelFiles.includes(path);
