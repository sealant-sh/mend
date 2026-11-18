import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import { normalizeUrl } from "../../.agents/skills/verify/scripts/guard/policy.mjs";
import { READ_FRONT, parseFront, startFrontRun } from "./box-front.mjs";
import { choosePorts, stopDrive } from "./ports.mjs";
import { readRun, run as runCommand, runEnv } from "./stack.mjs";

// `verify drive <surface> --recipe <name|path>`: run an existing recipe with the verify skill's own
// driver for that surface (Drive in .agents/skills/verify/SKILL.md). It adds no driver and no
// recipe format: a surface without recipes returns not_implemented.
//
// The terminal has two drivers, and each is recorded as it already works. `cli` runs a CLI batch, the
// steps.json that `steps.mjs` reads, against the stack's inner `mend`. `tui` runs nothing: the
// dashboard is driven by hand with drive-tui.sh's keys, so it records the captures drive-tui.sh
// wrote under <evidence>/<recipe>/tui, and only when drive-tui.sh's bundle was built from this
// commit with a clean tree and every capture was taken after that build.
//
// web, desktop and mobile-web drive the stack `verify stack up` started, as its first account;
// new-web drives the new web app (apps/web) from this checkout, served by drive-mobile.mjs --client
// new-web in front of that stack and signed in through the stack's own sign-in page;
// with --box, new-web needs no stack: the same proxy fronts the box's API, declared as the outer
// server (box-front.mjs), and the app signs in on its own /login as the box's account;
// t3 drives the t3code client serve-t3-client.mjs serves for that stack; vscode drives the world
// `drive-vscode.mjs up` made, which is its own server. Evidence lands in the run's evidence
// directory, <evidence>/<recipe>/<surface>.

const SKILL = ".agents/skills/verify";
export const SURFACES = ["web", "new-web", "cli", "tui", "desktop", "mobile-web", "vscode", "t3"];
const PREFIX = {
  "new-web-": "new-web",
  "vscode-": "vscode",
  "g4-": "vscode",
  "t3-": "t3",
  "web-": "web",
  "desktop-": "desktop",
  "mobile-": "mobile-web",
};

/** The surface a checked-in recipe drives: the driver its header names, else its name's prefix. */
export const surfaceOf = (text, name) => {
  const header = text.split("\n").slice(0, 30).join("\n");
  if (header.includes("serve-t3-client")) return "t3";
  if (header.includes("drive-vscode.mjs")) return "vscode";
  if (header.includes("drive-desktop")) return "desktop";
  if (header.includes("drive-mobile")) return "mobile-web";
  return Object.entries(PREFIX).find(([prefix]) => name.startsWith(prefix))?.[1] ?? "web";
};

/** Every checked-in recipe, by surface. Helper modules and tests are not recipes. */
export const listRecipes = (root) => {
  const dir = join(root, SKILL, "recipes");
  const recipes = {};
  for (const file of readdirSync(dir).toSorted()) {
    if (!file.endsWith(".mjs") || /\.(test|lib)\.mjs$/.test(file)) continue;
    const name = file.slice(0, -".mjs".length);
    const surface = surfaceOf(readFileSync(join(dir, file), "utf8"), name);
    (recipes[surface] ??= []).push(name);
  }
  return recipes;
};

const notImplemented = (surface, detail) => ({
  steps: [{ id: "recipe", title: `A recipe for ${surface}`, status: "not_implemented", detail }],
  next: [],
});

/** Resolves --recipe: a path to a module, or a checked-in recipe's name for this surface. */
export const resolveRecipe = (root, surface, recipe) => {
  const recipes = listRecipes(root);
  if (recipe.endsWith(".mjs") || recipe.includes("/")) {
    const path = isAbsolute(recipe) ? recipe : resolve(root, recipe);
    return existsSync(path)
      ? { path, name: basename(path, ".mjs") }
      : { error: `no recipe module at ${recipe}` };
  }
  if (!(recipes[surface] ?? []).includes(recipe)) {
    const known = recipes[surface] ?? [];
    return {
      missing:
        known.length === 0
          ? `no recipe drives ${surface} yet; write one from the feature map and pass its path`
          : `${recipe} is not a ${surface} recipe; these are: ${known.join(", ")}`,
    };
  }
  return { path: join(root, SKILL, "recipes", `${recipe}.mjs`), name: recipe };
};

const waitFor = async (check, timeoutMs, wait) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(500);
  }
  return check();
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const blocked = (id, title, detail, next) => ({
  steps: [{ id, title, status: "blocked_by_prerequisite", detail }],
  next,
});

/** drive-tui.sh's bundle, where `build` writes it, and the commit `build` stamped it with. */
export const tuiBundle = (env) => {
  const dir = join(
    env.XDG_CACHE_HOME || join(env.HOME ?? "", ".cache"),
    "mend-verify/tui-cli-bundle",
  );
  const stamp = join(dir, "source.json");
  return existsSync(stamp)
    ? { dir, stamp, source: JSON.parse(readFileSync(stamp, "utf8")) }
    : { dir, stamp, source: null };
};

/** The terminal's captures drive-tui.sh wrote for this recipe, judged against its bundle. */
const recordTui = ({ recipe, env, head, state }) => {
  const title = `${recipe} on tui`;
  const bundle = tuiBundle(env);
  const build = `${SKILL}/scripts/drive-tui.sh build .`;
  if (bundle.source === null)
    return blocked("bundle", "drive-tui.sh's bundle of this checkout", `no ${bundle.stamp}`, [
      build,
    ]);
  if (bundle.source.sha !== head.sha || bundle.source.dirty)
    return blocked(
      "bundle",
      "drive-tui.sh's bundle of this checkout",
      `the bundle is of ${bundle.source.sha.slice(0, 12)}${bundle.source.dirty ? " with uncommitted changes" : ""}, not this clean head ${head.sha.slice(0, 12)}`,
      [build, "then drive the dashboard again"],
    );
  const out = join(state.evidence, recipe, "tui");
  const built = statSync(bundle.stamp).mtimeMs;
  const captures = existsSync(out) ? readdirSync(out).filter((name) => name.endsWith(".txt")) : [];
  const stale = captures.filter((name) => statSync(join(out, name)).mtimeMs < built);
  const ok = captures.length > 0 && stale.length === 0;
  return {
    steps: [
      {
        id: "drive",
        title,
        status: ok ? "passed" : "failed",
        command: `drive-tui.sh capture <name> ${out} <step>`,
        log: join(out, "steps.log"),
        detail: ok
          ? `${captures.length} captures from the bundle of ${head.sha.slice(0, 12)}`
          : captures.length === 0
            ? `no drive-tui.sh capture in ${out}`
            : `taken before the bundle was built, so of another build: ${stale.join(", ")}`,
      },
    ],
    next: ok ? ["pnpm verify evidence"] : [],
    evidence: [{ kind: "drive", path: out }],
    drive: { surface: "tui", recipe, out },
  };
};

/** A CLI batch: a steps.json path, or the name of one checked in under recipes/. */
const cliBatch = (root, recipe) => {
  const path = recipe.includes("/")
    ? isAbsolute(recipe)
      ? recipe
      : resolve(root, recipe)
    : join(root, SKILL, "recipes", `${recipe}.json`);
  return existsSync(path)
    ? { path, name: basename(path, ".json") }
    : { error: `no CLI batch (steps.json) at ${path}` };
};

export const drive = async (
  root,
  {
    surface,
    recipe,
    head,
    env = process.env,
    exec = runCommand,
    background = spawn,
    wait = sleep,
    fetch = globalThis.fetch,
    timeoutMs,
    box = false,
    ssh = null,
  },
) => {
  // The terminal's recipe is the name of its captures' directory: there is no module to resolve.
  const found =
    surface === "tui"
      ? { name: recipe }
      : surface === "cli"
        ? cliBatch(root, recipe)
        : resolveRecipe(root, surface, recipe);
  if (found.missing) return notImplemented(surface, found.missing);
  if (found.error) {
    return {
      steps: [{ id: "recipe", title: "The recipe", status: "failed", detail: found.error }],
      next: [],
    };
  }
  const skill = join(root, SKILL, "scripts");
  const timeout = timeoutMs ? ["--timeout", String(timeoutMs)] : [];

  if (box && surface !== "new-web")
    return notImplemented(surface, "only new-web drives the box from this checkout (--box)");
  if (box)
    return driveNewWebOnBox({
      root,
      skill,
      found,
      head,
      env,
      ssh,
      exec,
      background,
      wait,
      fetch,
      timeout,
    });

  if (surface === "vscode") {
    const world = env.MEND_VERIFY_VSCODE_RUN;
    if (!world) {
      return {
        steps: [
          {
            id: "world",
            title: "A VS Code world from drive-vscode.mjs up",
            status: "blocked_by_prerequisite",
            detail: "MEND_VERIFY_VSCODE_RUN names no world",
          },
        ],
        next: [
          `node ${SKILL}/scripts/drive-vscode.mjs up --version <a preloaded ghcr.io/sealant-sh/mend tag> --extension .`,
          "export MEND_VERIFY_VSCODE_RUN=<the run up printed>",
        ],
      };
    }
    const out = join(
      env.XDG_STATE_HOME || join(env.HOME ?? "", ".local/state"),
      "mend-verify",
      `st-verify-vscode-${world}`,
      found.name,
    );
    mkdirSync(out, { recursive: true });
    const result = await exec(
      "node",
      [join(skill, "drive-vscode.mjs"), "run", found.path, "--out", out, ...timeout],
      { cwd: root, env, log: join(out, "drive.log") },
    );
    return finished("vscode", found, out, result.code);
  }

  const state = readRun(root);
  if (state === null || state.phase !== "ready") {
    return {
      steps: [
        {
          id: "stack",
          title: "A ready stack from verify stack up",
          status: "blocked_by_prerequisite",
          detail: state ? `the run's stack is ${state.phase}` : "no stack is up",
        },
      ],
      next: ["pnpm verify stack up"],
    };
  }
  if (surface === "tui") return recordTui({ recipe, env, head, state });
  const stepEnv = runEnv(root, env, state);
  const out = join(state.evidence, found.name, surface);
  mkdirSync(out, { recursive: true });
  const web = (target, extra) =>
    exec(
      "node",
      [
        join(skill, "drive-web.mjs"),
        "--web",
        target,
        "--out",
        out,
        "--private",
        state.private,
        "--recipe",
        found.path,
        ...extra,
        ...timeout,
      ],
      { cwd: root, env: stepEnv, log: join(out, "drive.log") },
    );

  if (surface === "cli") {
    const result = await exec(
      "node",
      [
        join(skill, "steps.mjs"),
        out,
        "session",
        "--worktree",
        state.worktree,
        "--project",
        state.project ?? "mend",
      ],
      { cwd: root, env: stepEnv, log: join(out, "drive.log"), input: readFileSync(found.path) },
    );
    return finished(
      surface,
      found,
      out,
      result.code,
      "steps.mjs did not bring back every step's result in full",
    );
  }

  if (surface === "web") {
    const result = await web(state.web, [
      "--account",
      join(state.private, "account.json"),
      "--state",
      join(state.private, "browser.json"),
    ]);
    return finished(surface, found, out, result.code);
  }

  if (surface === "t3") {
    const served = join(state.private, "t3-client.json");
    if (!existsSync(served)) {
      return {
        steps: [
          {
            id: "client",
            title: "The t3code client, served for this stack",
            status: "blocked_by_prerequisite",
            detail: "serve-t3-client.mjs has not recorded itself in the run's private directory",
          },
        ],
        next: [`see ${SKILL}/features/t3-gateway.md, "Driving the t3code client"`],
      };
    }
    const { port } = JSON.parse(readFileSync(served, "utf8"));
    const result = await web(`http://127.0.0.1:${port}`, []);
    return finished(surface, found, out, result.code);
  }

  if (surface === "desktop") {
    if (!existsSync(join(root, "apps/desktop/out"))) {
      return {
        steps: [
          {
            id: "build",
            title: "The desktop app, built from this checkout",
            status: "blocked_by_prerequisite",
            detail: "apps/desktop/out is missing",
          },
        ],
        next: ["pnpm --filter @mend/desktop build"],
      };
    }
    const started = await exec(
      join(skill, "drive-desktop.sh"),
      ["start", join(root, "apps/desktop"), state.web, "9335", ":95"],
      { cwd: root, env: stepEnv, log: join(out, "desktop.log") },
    );
    if (started.code !== 0)
      return finished(surface, found, out, started.code, "drive-desktop.sh start failed");
    try {
      const result = await web(state.web, ["--cdp", "http://127.0.0.1:9335"]);
      return finished(surface, found, out, result.code);
    } finally {
      await exec(join(skill, "drive-desktop.sh"), ["stop"], {
        cwd: root,
        env: stepEnv,
        log: join(out, "desktop.log"),
      });
    }
  }

  if (surface === "new-web")
    return driveNewWeb({
      root,
      skill,
      privateDir: state.private,
      fronts: ["--web", state.web],
      signIn: [
        "--account",
        join(state.private, "account.json"),
        "--sign-in",
        state.web,
        "--state",
        join(state.private, "browser.json"),
      ],
      stepEnv,
      web,
      found,
      out,
      background,
      wait,
      fetch,
    });

  // mobile-web: the proxy in front of the stack, for as long as the recipe runs.
  const recorded = join(state.private, "mobile.json");
  const proxy = background(
    "node",
    [
      join(skill, "drive-mobile.mjs"),
      "--app",
      join(root, "apps/mobile"),
      "--web",
      state.web,
      "--port",
      "18305",
      "--expo-port",
      "8085",
      "--log",
      `${state.private}.mobile.log`,
    ],
    { cwd: root, env: stepEnv, stdio: "ignore" },
  );
  try {
    if (!(await waitFor(() => existsSync(recorded), 300_000, wait))) {
      return finished(
        surface,
        found,
        out,
        1,
        `the mobile proxy did not record itself within 5 minutes (${state.private}.mobile.log)`,
      );
    }
    const result = await web("http://127.0.0.1:18305", ["--viewport", "390x844"]);
    return finished(surface, found, out, result.code);
  } finally {
    proxy.kill("SIGTERM");
  }
};

/**
 * The new web app on the box: no stack, and nothing on the box changes. The box must be the
 * declared outer server (MEND_VERIFY_OUTER_URL, its APP_URL as the box itself reports it), which is
 * what lets the guard pass the proxy and the driver. The app signs in on its own /login as the box
 * account (box-front.mjs), and the result names the build the box ran, for `box identity`.
 */
const driveNewWebOnBox = async ({
  root,
  skill,
  found,
  head,
  env,
  ssh,
  exec,
  background,
  wait,
  fetch,
  timeout,
}) => {
  if (ssh === null)
    return blocked("box", "Reach the box over ssh", "No box named: set MEND_VERIFY_BOX_SSH", [
      "export MEND_VERIFY_BOX_SSH='-J root@<proxmox host> root@<box vm>'",
    ]);
  const read = ssh(READ_FRONT);
  const box = parseFront(read.code === 0 ? read.stdout : "");
  if (box.appUrl === null)
    return blocked(
      "box",
      "Reach the box over ssh",
      `the box reported no APP_URL (ssh exited ${read.code})`,
      [],
    );
  if (!box.running)
    return blocked(
      "box",
      "Mend running on the box",
      `mend-mend-1 (${box.version ?? "no version"}) is not running: a release that put the data back leaves it stopped until the next deploy`,
      ["deploy a preview of main (docs/operations/preview-builds.md), then drive again"],
    );
  const declared = normalizeUrl(env.MEND_VERIFY_OUTER_URL ?? "");
  if (declared !== normalizeUrl(box.appUrl))
    return blocked(
      "outer",
      "The box declared as the outer server",
      `MEND_VERIFY_OUTER_URL is ${declared ?? "not set"}; the box's APP_URL is ${box.appUrl}`,
      [`export MEND_VERIFY_OUTER_URL=${box.appUrl}`],
    );
  const started = startFrontRun(root, { head, box, env });
  if (started.error)
    return blocked("account", "The box account's sign-in", started.error, [
      "export MEND_VERIFY_BOX_EMAIL=<email> MEND_VERIFY_BOX_PASSWORD_FILE=<file holding its password>",
    ]);
  const { run } = started;
  const stepEnv = {
    ...env,
    PATH: `${join(root, SKILL, "scripts/guard")}:${env.PATH}`,
    MEND_VERIFY_PRIVATE: run.private,
    MEND_VERIFY_MACHINE_XDG: env.MEND_VERIFY_MACHINE_XDG ?? "",
  };
  const out = join(run.evidence, found.name, "new-web");
  mkdirSync(out, { recursive: true });
  const web = (target, extra) =>
    exec(
      "node",
      [
        join(skill, "drive-web.mjs"),
        "--web",
        target,
        "--out",
        out,
        "--private",
        run.private,
        "--recipe",
        found.path,
        ...extra,
        ...timeout,
      ],
      { cwd: root, env: stepEnv, log: join(out, "drive.log") },
    );
  const result = await driveNewWeb({
    root,
    skill,
    privateDir: run.private,
    fronts: ["--outer"],
    signIn: [
      "--account",
      join(run.private, "account.json"),
      "--state",
      join(run.private, "browser.json"),
    ],
    stepEnv,
    web,
    found,
    out,
    background,
    wait,
    fetch,
  });
  result.drive.box = { web: box.appUrl, revision: box.revision, version: box.version };
  result.steps[0].detail += `; in front of the box's API (${box.version}, revision ${box.revision?.slice(0, 12) ?? "unknown"})`;
  if (result.steps[0].status === "passed")
    result.next = ["pnpm verify box identity", "pnpm verify evidence"];
  return result;
};

/**
 * The new web app: its vite server and a Mend API on one origin (drive-mobile.mjs --client
 * new-web), for as long as the recipe runs. `fronts` names that API: the stack's tunnel, or the
 * declared outer (--outer, the box). Its first page compiles on demand, so the recipe starts once
 * the app answers through the proxy (any answer but the proxy's own 502).
 */
const driveNewWeb = async ({
  root,
  skill,
  privateDir,
  fronts,
  signIn,
  stepEnv,
  web,
  found,
  out,
  background,
  wait,
  fetch,
}) => {
  const [port, vitePort] = await choosePorts([
    stepEnv.MEND_VERIFY_NEW_WEB_PORT,
    stepEnv.MEND_VERIFY_NEW_WEB_VITE_PORT,
  ]);
  const address = `http://localhost:${port}`;
  const finish = (code, why) => {
    const result = finished("new-web", found, out, code, why);
    result.drive.web = address;
    result.drive.vitePort = vitePort;
    result.steps[0].detail = `${address}${result.steps[0].detail ? `; ${result.steps[0].detail}` : ""}`;
    return result;
  };
  const recorded = join(privateDir, "new-web.json");
  const proxy = background(
    "node",
    [
      join(skill, "drive-mobile.mjs"),
      "--client",
      "new-web",
      "--app",
      join(root, "apps/web"),
      ...fronts,
      "--port",
      String(port),
      "--expo-port",
      String(vitePort),
      "--log",
      `${privateDir}.new-web.log`,
    ],
    { cwd: root, env: stepEnv, stdio: "ignore", detached: true },
  );
  let interrupted;
  const interrupt = (signal) => {
    interrupted ??= stopDrive(proxy, [port, vitePort]).then(() =>
      process.exit(signal === "SIGINT" ? 130 : 143),
    );
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const answers = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/login`)).status !== 502;
    } catch {
      return false;
    }
  };
  try {
    let up = await waitFor(() => existsSync(recorded), 120_000, wait);
    const deadline = Date.now() + 120_000;
    while (up && !(await answers())) {
      if (Date.now() >= deadline) up = false;
      else await wait(1000);
    }
    if (!up) {
      return finish(
        1,
        `the new web app did not answer within 4 minutes (${privateDir}.new-web.log)`,
      );
    }
    const result = await web(address, signIn);
    return finish(result.code);
  } finally {
    await stopDrive(proxy, [port, vitePort]);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
};

const finished = (surface, found, out, code, why) => ({
  steps: [
    {
      id: "drive",
      title: `${found.name} on ${surface}`,
      status: code === 0 ? "passed" : "failed",
      command: `${surface} recipe ${found.path}`,
      log: join(out, "drive.log"),
      ...(code === 0
        ? {}
        : {
            detail: why ?? `the recipe failed (exit ${code}); failure-<n>.* in ${out} shows where`,
          }),
    },
  ],
  next: code === 0 ? ["pnpm verify evidence"] : [],
  evidence: [{ kind: "drive", path: out }],
  drive: { surface, recipe: found.name, out },
});
