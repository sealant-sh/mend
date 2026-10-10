/**
 * The Node the CLI runs on: the oldest it takes, and the one warning Node prints about the CLI's own
 * modules that a user can do nothing about.
 */

/**
 * The oldest Node every command runs on: node:sqlite (Codex memory import) loads without a flag
 * from 22.13. Kept equal to `engines.node` in package.json and to install.sh's check.
 */
export const MIN_NODE = [22, 13] as const;

/** One plain line when this Node is older than the CLI takes, or null. */
export const nodeVersionIssue = (version: string): string | null => {
  const [major = Number.NaN, minor = Number.NaN] = version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number(part));
  const [minMajor, minMinor] = MIN_NODE;
  if (Number.isNaN(major) || Number.isNaN(minor)) return null;
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return null;
  return `Node.js ${minMajor}.${minMinor} or newer is required; this is ${version.startsWith("v") ? version : `v${version}`}. Upgrade Node.js, then run it again.`;
};

/** Node's warning that node:sqlite is experimental, which it prints on Node 22 as the module loads. */
export const isSqliteExperimentalWarning = (warning: Error): boolean =>
  warning.name === "ExperimentalWarning" && warning.message.startsWith("SQLite ");

/**
 * Drop the SQLite ExperimentalWarning from this process's output and keep every other warning:
 * Node prints warnings from its own `warning` listener, so that listener is wrapped.
 */
export const quietSqliteWarning = (): void => {
  const printers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (isSqliteExperimentalWarning(warning)) return;
    for (const print of printers) print(warning);
  });
};
