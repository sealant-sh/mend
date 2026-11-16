// The receipt recheck (.github/workflows/receipt-recheck.yml): after a PR's body is edited, or its
// waiver label changes, re-run CI's `receipt` job (and `checks`, which needs it) in the head's run
// when it has already read an older body. It reads the PR, the run and its jobs, and asks for one
// re-run; it never reads or runs anything from the PR's branch.

const NOT_STARTED = new Set(["queued", "waiting", "pending", "requested"]);
const FINE = new Set(["success", "skipped"]);

/**
 * What to do with the head's CI run: `done` (with why), `wait` while `receipt` has run but the run
 * has not finished (a finished run is the only one GitHub re-runs a job of), or `rerun` the job.
 */
export const nextStep = (run, jobs) => {
  if (run === undefined)
    return { done: "no CI run for the head yet: its receipt job will read the body" };
  const receipt = jobs.find((job) => job.name === "receipt");
  if (run.status !== "completed") {
    if (receipt === undefined || NOT_STARTED.has(receipt.status))
      return { done: "receipt has not started: it will read the new body when it runs" };
    return { wait: true };
  }
  if (receipt?.conclusion !== "failure")
    return { done: `receipt reads ${receipt?.conclusion ?? "missing"}: nothing to re-run` };
  const failed = jobs.filter(
    (job) => !["receipt", "checks"].includes(job.name) && !FINE.has(job.conclusion),
  );
  if (failed.length > 0)
    return {
      done: `not re-running: ${failed.map((job) => `${job.name} ${job.conclusion}`).join(", ")} would fail checks again`,
    };
  return { rerun: receipt.id };
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const main = async ({ env = process.env, call, wait = sleep, looks = 40 }) => {
  const pr = await call(`/pulls/${env.PR_NUMBER}`);
  const { workflow_runs: runs } = await call(
    `/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=10`,
  );
  const latest = runs.toSorted((a, b) => b.run_number - a.run_number)[0];
  for (let look = 0; look < looks; look++) {
    const run = latest && (await call(`/actions/runs/${latest.id}`));
    const jobs = run
      ? (await call(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)).jobs
      : [];
    const step = nextStep(run, jobs);
    if (step.done) return `${pr.head.sha.slice(0, 10)}: ${step.done}`;
    if (step.rerun) {
      await call(`/actions/jobs/${step.rerun}/rerun`, "POST");
      return `${pr.head.sha.slice(0, 10)}: re-ran receipt, and checks after it, in ${run.html_url}`;
    }
    // `receipt` waits for every other job, so a run past it is left only `checks`: seconds.
    await wait(20_000);
  }
  throw new Error(`run ${latest.id} did not finish after its receipt job ran`);
};

/** A GitHub REST call with the job's token. */
export const github =
  (env) =>
  async (path, method = "GET") => {
    const response = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}${path}`, {
      method,
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json" },
    });
    if (!response.ok)
      throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
    return response.status === 201 || response.status === 204 ? null : response.json();
  };

if (import.meta.main) console.log(await main({ call: github(process.env) }));
