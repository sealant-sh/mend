import { spawnSync } from "node:child_process";

/** Shared event policy for static checks and both processes in each test lane. */
export const ciTurboOptions = (env) => {
  const measurement = env.CI_MEASUREMENT_CACHE;
  if (
    measurement &&
    (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || !["cold", "warm"].includes(measurement))
  ) {
    return {
      _tag: "error",
      message: "CI_MEASUREMENT_CACHE requires a cold or warm workflow_dispatch.",
    };
  }
  const affected = env.GITHUB_EVENT_NAME === "pull_request" || Boolean(measurement);
  if (affected && !/^[a-f0-9]{40}$/i.test(env.TURBO_SCM_BASE ?? "")) {
    return {
      _tag: "error",
      message: "Affected runs require TURBO_SCM_BASE to be the exact base SHA.",
    };
  }
  const trusted =
    (env.GITHUB_EVENT_NAME === "schedule" && env.GITHUB_REF === "refs/heads/main") ||
    (env.GITHUB_EVENT_NAME === "merge_group" &&
      env.GITHUB_REF?.startsWith("refs/heads/gh-readonly-queue/main/"));
  const remote = env.RUNNER_ENVIRONMENT === "self-hosted" && measurement !== "cold";
  const force = env.GITHUB_EVENT_NAME === "schedule" && trusted;
  return {
    _tag: "ok",
    args: [
      "--env-mode=strict",
      // Turbo rejects --force together with --cache. Forced runs use its default
      // write-through caches; only box jobs configure a remote endpoint.
      ...(force
        ? ["--force"]
        : [`--cache=local:rw${remote ? (trusted ? ",remote:rw" : ",remote:r") : ""}`]),
      ...(affected ? ["--affected"] : []),
      "--summarize",
    ],
  };
};

const main = () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "configure") {
    console.log(`MEND_CI_RUNTIME=${process.version}/${process.platform}/${process.arch}`);
    // The host proxy owns write authorization. This non-secret token only satisfies Turbo.
    if (process.env.RUNNER_ENVIRONMENT === "self-hosted") {
      console.log("TURBO_API=http://10.0.1.1:8941\nTURBO_TEAM=mend\nTURBO_TOKEN=box");
    }
    return;
  }
  if (args.length === 0 || args.some((task) => !["build", "lint", "typecheck"].includes(task))) {
    console.error("Usage: node scripts/ci-turbo.mjs configure|build|lint|typecheck [...tasks]");
    process.exitCode = 1;
    return;
  }
  const options = ciTurboOptions(process.env);
  if (options._tag === "error") {
    console.error(options.message);
    process.exitCode = 1;
    return;
  }
  const result = spawnSync("pnpm", ["exec", "turbo", "run", ...args, ...options.args], {
    stdio: "inherit",
  });
  if (result.error) console.error(`Cannot start pnpm: ${result.error.message}`);
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
};

if (import.meta.main) main();
