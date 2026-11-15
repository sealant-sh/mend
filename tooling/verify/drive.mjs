import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import { readRun, run as runCommand, runEnv } from "./stack.mjs";

// `verify drive <surface> --recipe <name|path>`: run an existing recipe with the verify skill's own
// driver for that surface (Drive in .agents/skills/verify/SKILL.md). It adds no driver and no
// recipe format: a surface without recipes, or without a recipe module format (the terminal's
// drive-tui.sh takes keys), returns not_implemented.
//
// web, desktop and mobile-web drive the stack `verify stack up` started, as its first account;
// t3 drives the t3code client serve-t3-client.mjs serves for that stack; vscode drives the world
// `drive-vscode.mjs up` made, which is its own server. Evidence lands in the run's evidence
// directory, <evidence>/<recipe>/<surface>.

const SKILL = ".agents/skills/verify";
export const SURFACES = ["web", "tui", "desktop", "mobile-web", "vscode", "t3"];
const PREFIX = {
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

export const drive = async (
  root,
  {
    surface,
    recipe,
    env = process.env,
    exec = runCommand,
    background = spawn,
    wait = sleep,
    timeoutMs,
  },
) => {
  if (surface === "tui") {
    return notImplemented(
      "tui",
      "drive-tui.sh takes keys and captures, not a recipe module; there is no terminal recipe format yet",
    );
  }
  const found = resolveRecipe(root, surface, recipe);
  if (found.missing) return notImplemented(surface, found.missing);
  if (found.error) {
    return {
      steps: [{ id: "recipe", title: "The recipe", status: "failed", detail: found.error }],
      next: [],
    };
  }
  const skill = join(root, SKILL, "scripts");
  const timeout = timeoutMs ? ["--timeout", String(timeoutMs)] : [];

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
