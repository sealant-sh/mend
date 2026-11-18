import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readFrontRun } from "./box-front.mjs";
import { drive, listRecipes, resolveRecipe, surfaceOf } from "./drive.mjs";
import { artifacts, driveResults, evidence } from "./evidence.mjs";
import { choosePorts } from "./ports.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));

// A checkout with one recipe per kind, and a ready stack recorded the way `verify stack up` does.
const world = (t, { phase = "ready" } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "mend-verify-drive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recipes = join(root, ".agents/skills/verify/recipes");
  mkdirSync(recipes, { recursive: true });
  writeFileSync(join(recipes, "web-projects.mjs"), "export default async () => {};\n");
  writeFileSync(join(recipes, "vscode-open.mjs"), "// node drive-vscode.mjs run\n");
  writeFileSync(join(recipes, "vscode-review.lib.mjs"), "export const helper = 1;\n");
  mkdirSync(join(root, ".verify/stack"), { recursive: true });
  const state = {
    run: "1115-0000-abcd",
    worktree: "st-verify-1115-0000-abcd",
    project: "mend",
    web: "http://localhost:3373",
    evidence: join(root, "evidence"),
    private: join(root, "private"),
    phase,
  };
  mkdirSync(state.private, { recursive: true });
  writeFileSync(join(root, ".verify/stack/current.json"), JSON.stringify(state));
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ line: [command, ...args].join(" "), env: options.env, input: options.input });
    return { code: 0, stdout: "" };
  };
  return { root, state, exec, calls };
};

test("a recipe's surface is the driver its header names, else its prefix; helpers are no recipe", () => {
  assert.equal(surfaceOf("// node drive-vscode.mjs run …", "g4-terminal-agent-waits"), "vscode");
  assert.equal(surfaceOf("// drive-web.mjs … serve-t3-client", "t3-client"), "t3");
  assert.equal(surfaceOf("export default async () => {}", "vscode-handoff"), "vscode");
  assert.equal(surfaceOf("export default async () => {}", "web-projects"), "web");
  const checkedIn = listRecipes(repo);
  assert.ok(checkedIn.vscode.includes("g4-terminal-agent-waits"));
  assert.deepEqual(checkedIn.t3, ["t3-client"]);
  assert.ok(checkedIn.web.includes("web-projects"));
  assert.ok(
    !Object.values(checkedIn)
      .flat()
      .some((name) => name.endsWith(".lib")),
  );
});

test("a surface with no recipe, or a name from another surface, is not_implemented", async (t) => {
  const { root, exec } = world(t);
  assert.match(resolveRecipe(root, "web", "vscode-open").missing, /these are: web-projects/);
  for (const [surface, recipe] of [
    ["desktop", "web-projects"],
    ["web", "vscode-open"],
  ]) {
    const result = await drive(root, { surface, recipe, exec });
    assert.equal(result.steps[0].status, "not_implemented", `${surface} ${recipe}`);
  }
});

test("web drives the run's own stack through drive-web, as its first account", async (t) => {
  const { root, state, exec, calls } = world(t);
  const result = await drive(root, { surface: "web", recipe: "web-projects", exec });
  assert.equal(result.steps[0].status, "passed");
  const call = calls[0].line;
  for (const part of [
    "drive-web.mjs",
    `--web ${state.web}`,
    `--private ${state.private}`,
    `--account ${state.private}/account.json`,
    `--state ${state.private}/browser.json`,
    `--out ${state.evidence}/web-projects/web`,
  ])
    assert.ok(call.includes(part), part);
  assert.ok(calls[0].env.PATH.includes(".agents/skills/verify/scripts/guard"));
});

test("cli runs a steps.json batch with steps.mjs in the run's own worktree", async (t) => {
  const { root, state, exec, calls } = world(t);
  const batch = join(root, "login-flow.json");
  writeFileSync(batch, '[{"name": "01-whoami", "run": ["mend", "whoami"]}]');
  const result = await drive(root, { surface: "cli", recipe: batch, exec });
  assert.equal(result.steps[0].status, "passed");
  assert.deepEqual(result.drive, {
    surface: "cli",
    recipe: "login-flow",
    out: join(state.evidence, "login-flow/cli"),
  });
  const call = calls[0];
  assert.ok(call.line.includes(`steps.mjs ${state.evidence}/login-flow/cli session`));
  assert.ok(call.line.includes(`--worktree ${state.worktree} --project mend`));
  assert.match(String(call.input), /01-whoami/);

  const failing = async () => ({ code: 1, stdout: "" });
  const lost = await drive(root, { surface: "cli", recipe: batch, exec: failing });
  assert.equal(lost.steps[0].status, "failed");
  const missing = await drive(root, { surface: "cli", recipe: "./nope.json", exec });
  assert.equal(missing.steps[0].status, "failed");
});

test("tui records drive-tui.sh's captures only from a clean bundle of this head", async (t) => {
  const { root, state, exec, calls } = world(t);
  const head = { sha: "d".repeat(40), dirty: false };
  const env = { XDG_CACHE_HOME: join(root, "cache") };
  const bundle = join(root, "cache/mend-verify/tui-cli-bundle");
  const out = join(state.evidence, "dashboard/tui");
  const tui = () => drive(root, { surface: "tui", recipe: "dashboard", head, env, exec });
  const stamp = (sha, dirty) => {
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "source.json"), JSON.stringify({ sha, dirty }));
    utimesSync(join(bundle, "source.json"), 1000, 1000);
  };
  const capture = (name, seconds) => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, name), "projects\n");
    utimesSync(join(out, name), seconds, seconds);
  };

  assert.equal((await tui()).steps[0].status, "blocked_by_prerequisite", "never built");
  stamp("e".repeat(40), false);
  assert.match((await tui()).steps[0].detail, /not this clean head/);
  stamp(head.sha, true);
  assert.match((await tui()).steps[0].detail, /uncommitted changes/);
  stamp(head.sha, false);
  assert.match((await tui()).steps[0].detail, /no drive-tui.sh capture/);

  capture("01-projects.txt", 2000);
  const passed = await tui();
  assert.equal(passed.steps[0].status, "passed");
  assert.deepEqual(passed.drive, { surface: "tui", recipe: "dashboard", out });

  capture("00-before.txt", 500);
  const stale = await tui();
  assert.equal(stale.steps[0].status, "failed");
  assert.match(stale.steps[0].detail, /00-before\.txt/);
  assert.equal(calls.length, 0, "recording runs nothing");
});

test("without a ready stack, or a VS Code world, a drive is blocked and says what to start", async (t) => {
  const down = world(t, { phase: "down" });
  const web = await drive(down.root, { surface: "web", recipe: "web-projects", exec: down.exec });
  assert.equal(web.steps[0].status, "blocked_by_prerequisite");
  assert.deepEqual(web.next, ["pnpm verify stack up"]);
  const vscode = await drive(down.root, {
    surface: "vscode",
    recipe: "vscode-open",
    exec: down.exec,
    env: {},
  });
  assert.equal(vscode.steps[0].status, "blocked_by_prerequisite");
  assert.equal(down.calls.length, 0);
});

test("mobile-web keeps its proxy only for the recipe, and stops it when the recipe fails", async (t) => {
  const { root, state, calls } = world(t);
  writeFileSync(join(state.private, "mobile.json"), "{}");
  let killed = null;
  const background = (_command, args) => {
    calls.push({ line: args.join(" ") });
    return { kill: (signal) => (killed = signal) };
  };
  const failing = async (command, args) => {
    calls.push({ line: [command, ...args].join(" ") });
    return { code: 1, stdout: "" };
  };
  const result = await drive(root, {
    surface: "mobile-web",
    recipe: join(root, ".agents/skills/verify/recipes/web-projects.mjs"),
    exec: failing,
    background,
    wait: async () => {},
  });
  assert.equal(result.steps[0].status, "failed");
  assert.equal(killed, "SIGTERM");
  assert.ok(
    calls.some(
      (call) =>
        call.line.includes("--web http://127.0.0.1:18305") &&
        call.line.includes("--viewport 390x844"),
    ),
  );
});

test("new-web drives the new app once it answers, signed in through the stack, and stops it after", async (t) => {
  const { root, state, exec, calls } = world(t);
  writeFileSync(join(state.private, "new-web.json"), "{}");
  let child;
  const background = (_command, args, options) => {
    calls.push({ line: args.join(" ") });
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      ...options,
      stdio: "ignore",
    });
    return child;
  };
  // The proxy answers 502 until vite has compiled the first page.
  const answers = [502, 502, 404];
  const fetch = async () => ({ status: answers.shift() ?? 404 });
  const result = await drive(root, {
    surface: "new-web",
    recipe: join(root, ".agents/skills/verify/recipes/web-projects.mjs"),
    exec,
    background,
    wait: async () => {},
    fetch,
  });
  assert.equal(result.steps[0].status, "passed");
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(answers.length, 0, "the recipe waited for the app to answer");
  const [proxy, driven] = calls.map((call) => call.line);
  assert.match(
    proxy,
    /drive-mobile\.mjs --client new-web --app \S+\/apps\/web --web http:\/\/localhost:3373/,
  );
  for (const part of [
    `--web ${result.drive.web}`,
    `--account ${state.private}/account.json`,
    `--sign-in ${state.web}`,
  ])
    assert.ok(driven.includes(part), part);
});

test("new-web releases its servers after a failed recipe or an exception", async (t) => {
  for (const failure of ["exit", "throw"]) {
    const { root, state } = world(t);
    const pinned = await choosePorts([undefined, undefined]);
    writeFileSync(join(state.private, "new-web.json"), "{}");
    let child;
    let ready;
    let ports;
    const background = (_command, args, options) => {
      ports = [
        Number(args[args.indexOf("--port") + 1]),
        Number(args[args.indexOf("--expo-port") + 1]),
      ];
      child = spawn(
        process.execPath,
        [
          "-e",
          `
        const net = require('node:net');
        let count = 0;
        for (const port of JSON.parse(process.argv[1]))
          net.createServer().listen(port, '127.0.0.1', () => {
            if (++count === 2) process.send('ready');
          });
      `,
          JSON.stringify(ports),
        ],
        { ...options, stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      ready = once(child, "message");
      return child;
    };
    const options = {
      surface: "new-web",
      recipe: join(root, ".agents/skills/verify/recipes/web-projects.mjs"),
      env: {
        ...process.env,
        MEND_VERIFY_NEW_WEB_PORT: String(pinned[0]),
        MEND_VERIFY_NEW_WEB_VITE_PORT: String(pinned[1]),
      },
      background,
      fetch: async () => {
        await ready;
        return { status: 200 };
      },
      exec: async () => {
        if (failure === "throw") throw new Error("recipe crashed");
        return { code: 1 };
      },
    };
    if (failure === "throw") await assert.rejects(drive(root, options), /recipe crashed/);
    else {
      const result = await drive(root, options);
      assert.equal(result.steps[0].status, "failed");
      assert.equal(new URL(result.drive.web).port, String(ports[0]));
    }
    assert.deepEqual(ports, pinned);
    assert.notEqual(child.signalCode, null);
    assert.deepEqual(await choosePorts(ports.map(String)), ports);
  }
});

test("interrupting a new-web drive releases both ports", async (t) => {
  const { root, state } = world(t);
  const scripts = join(root, ".agents/skills/verify/scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(scripts, "drive-mobile.mjs"),
    `
    import { createServer } from 'node:net';
    import { writeFileSync } from 'node:fs';
    const arg = (name) => Number(process.argv[process.argv.indexOf(name) + 1]);
    let ready = 0;
    const ports = [arg('--port'), arg('--expo-port')];
    for (const port of ports)
      createServer().listen(port, '127.0.0.1', () => {
        if (++ready === 2) writeFileSync(${JSON.stringify(join(state.private, "new-web.json"))}, JSON.stringify({ ports }));
      });
  `,
  );
  const recipe = join(root, ".agents/skills/verify/recipes/web-projects.mjs");
  const child = fork(
    "-e",
    [
      `
    const { drive } = await import(${JSON.stringify(new URL("./drive.mjs", import.meta.url).href)});
    await drive(${JSON.stringify(root)}, {
      surface: 'new-web', recipe: ${JSON.stringify(recipe)},
      fetch: async () => ({ status: 200 }),
      exec: async (_command, args) => {
        process.send({ web: args[args.indexOf('--web') + 1] });
        await new Promise(() => {});
      },
    });
  `,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  t.after(() => child.kill());
  const [{ web }] = await once(child, "message");
  const port = Number(new URL(web).port);
  await assert.rejects(choosePorts([String(port)]), { code: "EADDRINUSE" });
  const closed = once(child, "close");
  child.kill("SIGINT");
  assert.deepEqual(await closed, [130, null]);
  const { ports } = JSON.parse(readFileSync(join(state.private, "new-web.json"), "utf8"));
  assert.deepEqual(await choosePorts(ports.map(String)), ports);
});

test("evidence takes only this head's clean drives, sorts what each made, and writes the verdict", async (t) => {
  const { root, state, exec, calls } = world(t);
  const head = { sha: "a".repeat(40), branch: "b", dirty: false };
  const out = join(state.evidence, "web-projects/web");
  mkdirSync(out, { recursive: true });
  for (const name of [
    "projects.png",
    "projects.png.checked",
    "login.png.withheld",
    "projects.aria.yml",
    "steps.log",
    "stray.png",
  ])
    writeFileSync(join(out, name), "x");
  mkdirSync(join(state.evidence, "doctor"), { recursive: true });
  writeFileSync(
    join(state.evidence, "doctor/doctor.txt"),
    "ok   web version 0.36.0-verify.tabc · this session's stack built it\nok   mend at 586ec384 · expected 586ec384\n",
  );
  const results = join(root, ".verify/results");
  mkdirSync(results, { recursive: true });
  const saved = (name, sha, dirty, status) =>
    writeFileSync(
      join(results, name),
      JSON.stringify({
        verb: "drive web",
        status,
        head: { sha, dirty },
        drive: { surface: "web", recipe: "web-projects", out },
      }),
    );
  saved("drive-web-20261115T000001Z.json", head.sha, false, "passed");
  saved("drive-web-20261115T000002Z.json", head.sha, true, "failed");
  saved("drive-web-20261115T000003Z.json", "b".repeat(40), false, "failed");
  assert.deepEqual(
    driveResults(root, head).map((result) => result.status),
    ["passed"],
  );

  const found = artifacts(out);
  assert.equal(found.screenshots.length, 1, "an image without .checked is not evidence");
  assert.equal(found.withheld.length, 1);

  const result = await evidence(root, { head, exec, statusLines: ["- `pre-pr-checks`: passed"] });
  assert.deepEqual(
    result.steps.map((step) => [step.id, step.status]),
    [
      ["drives", "passed"],
      ["scan", "passed"],
      ["verdict", "passed"],
    ],
  );
  assert.ok(
    calls.some((call) =>
      call.line.includes(
        `scan-evidence.mjs --dir ${state.evidence} --secrets ${state.private} --delete-hits`,
      ),
    ),
  );
});

test("a scan hit withholds the evidence instead of passing it", async (t) => {
  const { root, state } = world(t);
  const head = { sha: "c".repeat(40), branch: "b", dirty: false };
  const results = join(root, ".verify/results");
  mkdirSync(results, { recursive: true });
  writeFileSync(
    join(results, "drive-web-20261115T000001Z.json"),
    JSON.stringify({
      verb: "drive web",
      status: "passed",
      head: { sha: head.sha, dirty: false },
      drive: { surface: "web", recipe: "web-projects", out: join(state.evidence, "x") },
    }),
  );
  const result = await evidence(root, { head, exec: async () => ({ code: 1, stdout: "" }) });
  assert.equal(result.steps.find((step) => step.id === "scan").status, "evidence_withheld");
});

// The box as `drive new-web --box` meets it: READ_FRONT's answer, and the account it signs in as.
const boxWorld = (t, { appUrl = "https://box.example.test", running = "true" } = {}) => {
  const { root, exec, calls } = world(t);
  const head = { sha: "d".repeat(40), branch: "b", dirty: false };
  const password = join(root, "password");
  writeFileSync(password, "box-check-password\n");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    MEND_VERIFY_OUTER_URL: appUrl,
    MEND_VERIFY_BOX_EMAIL: "check@example.test",
    MEND_VERIFY_BOX_PASSWORD_FILE: password,
  };
  const ssh = () => ({
    code: 0,
    stdout: [
      "version=0.37.0-next.1.preview.9",
      `revision=${"e".repeat(40)}`,
      `running=${running}`,
      "APP_URL=https://box.example.test",
    ].join("\n"),
    stderr: "",
  });
  const privateDir = join(root, "state/mend-verify", `box-${basename(root)}`, "private");
  return { root, exec, calls, head, env, ssh, privateDir };
};

test("new-web --box fronts the declared box from this checkout and signs in on the app's own page", async (t) => {
  const { root, exec, calls, head, env, ssh, privateDir } = boxWorld(t);
  let child;
  const background = (_command, args, options) => {
    calls.push({ line: args.join(" ") });
    writeFileSync(join(privateDir, "new-web.json"), "{}");
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      ...options,
      stdio: "ignore",
    });
    return child;
  };
  const result = await drive(root, {
    surface: "new-web",
    recipe: join(root, ".agents/skills/verify/recipes/web-projects.mjs"),
    head,
    env,
    exec,
    ssh,
    box: true,
    background,
    wait: async () => {},
    fetch: async () => ({ status: 200 }),
  });
  assert.equal(result.steps[0].status, "passed");
  assert.equal(child.signalCode, "SIGTERM");
  const [proxy, driven] = calls.map((call) => call.line);
  assert.match(proxy, /drive-mobile\.mjs --client new-web --app \S+\/apps\/web --outer --port/);
  assert.doesNotMatch(proxy, /--web /, "the proxy fronts the declared outer, nothing named");
  assert.ok(driven.includes(`--account ${privateDir}/account.json`));
  assert.ok(driven.includes(`--state ${privateDir}/browser.json`));
  assert.doesNotMatch(driven, /--sign-in/, "the new app signs in on its own /login");
  assert.equal(calls[1].env.MEND_VERIFY_PRIVATE, privateDir);
  assert.deepEqual(result.drive.box, {
    web: "https://box.example.test",
    revision: "e".repeat(40),
    version: "0.37.0-next.1.preview.9",
  });
  assert.deepEqual(JSON.parse(readFileSync(join(privateDir, "account.json"), "utf8")), {
    email: "check@example.test",
    password: "box-check-password",
  });
  assert.equal(statSync(privateDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(privateDir, "account.json")).mode & 0o777, 0o600);
  assert.equal(readFrontRun(root).revision, "e".repeat(40));
  assert.equal(
    readFrontRun(root).evidence,
    join(root, "state/mend-verify", `box-${basename(root)}`, "evidence", head.sha.slice(0, 12)),
    "each head's evidence apart, under one private directory per checkout",
  );
  assert.deepEqual(result.next, ["pnpm verify box identity", "pnpm verify evidence"]);
});

test("new-web --box refuses a box it was not told of, a stopped Mend, no ssh, and other surfaces", async (t) => {
  const go = (world, extra = {}) =>
    drive(world.root, {
      surface: "new-web",
      recipe: join(world.root, ".agents/skills/verify/recipes/web-projects.mjs"),
      head: world.head,
      env: world.env,
      exec: world.exec,
      ssh: world.ssh,
      box: true,
      ...extra,
    });
  const elsewhere = boxWorld(t, { appUrl: "https://someone-else.example.test" });
  const refused = await go(elsewhere);
  assert.equal(refused.steps[0].status, "blocked_by_prerequisite");
  assert.equal(refused.steps[0].id, "outer");
  assert.deepEqual(refused.next, ["export MEND_VERIFY_OUTER_URL=https://box.example.test"]);
  assert.equal(readFrontRun(elsewhere.root), null, "nothing written for a box it may not reach");

  const stopped = await go(boxWorld(t, { running: "false" }));
  assert.equal(stopped.steps[0].status, "blocked_by_prerequisite");
  assert.match(stopped.steps[0].detail, /is not running/);

  const unnamed = await go(boxWorld(t), { ssh: null });
  assert.equal(unnamed.steps[0].status, "blocked_by_prerequisite");

  const web = await go(boxWorld(t), { surface: "web" });
  assert.equal(web.steps[0].status, "not_implemented");
});

test("evidence scans a box drive with the box check's own registry and names the box's build", async (t) => {
  const { root, exec, calls } = world(t);
  rmSync(join(root, ".verify/stack/current.json"));
  const head = { sha: "f".repeat(40), branch: "b", dirty: false };
  const front = {
    head: head.sha,
    web: "https://box.example.test",
    revision: "e".repeat(40),
    version: "0.37.0-next.1.preview.9",
    private: join(root, "box/private"),
    evidence: join(root, "box/evidence"),
  };
  mkdirSync(front.private, { recursive: true });
  mkdirSync(join(root, ".verify/box"), { recursive: true });
  writeFileSync(join(root, ".verify/box/front.json"), JSON.stringify(front));
  const results = join(root, ".verify/results");
  mkdirSync(results, { recursive: true });
  const box = { web: front.web, revision: front.revision, version: front.version };
  for (const [name, drove] of [
    [
      "drive-new-web-20261118T000001Z.json",
      { box, out: join(front.evidence, "new-web-inbox/new-web") },
    ],
    ["drive-new-web-20261118T000002Z.json", { out: join(root, "evidence/new-web-inbox/new-web") }],
  ])
    writeFileSync(
      join(results, name),
      JSON.stringify({
        verb: "drive new-web",
        status: "passed",
        head: { sha: head.sha, dirty: false },
        drive: { surface: "new-web", recipe: "new-web-inbox", ...drove },
      }),
    );
  assert.equal(driveResults(root, head).length, 2, "a box drive and a stack drive of one recipe");
  const result = await evidence(root, { head, exec });
  assert.equal(result.steps.find((step) => step.id === "scan-box").status, "passed");
  assert.ok(
    calls.some((call) =>
      call.line.includes(
        `scan-evidence.mjs --dir ${front.evidence} --secrets ${front.private} --delete-hits`,
      ),
    ),
  );
  const verdict = readFileSync(join(root, result.evidence[0].path), "utf8");
  assert.match(
    verdict,
    /the box https:\/\/box\.example\.test runs 0\.37\.0-next\.1\.preview\.9, revision e{40}/,
  );
  assert.match(verdict, /new-web on the box · `new-web-inbox`/);
});
