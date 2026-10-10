// The guard and its policy (guard/mend, guard/policy.mjs), and every driver's way to a Mend client:
// a verifier never talks to the owner's server. Node only; the terminal case needs tmux and is
// skipped, with that reason, where it is not installed.
//
//   node --test .claude/skills/verify/scripts/guard.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Refused, checkCli, checkTarget, identityOf, realCli, runHome } from "./guard/policy.mjs";

/** A tunnel record as tunnel.mjs leaves a bound one: held by a live process (this test's). */
const tunnelTo = (dir, port, extra = {}) =>
  writeFileSync(
    join(dir, "tunnel.json"),
    JSON.stringify({
      port: String(port),
      pid: process.pid,
      identity: identityOf(process.pid),
      bound: true,
      ...extra,
    }),
  );

const scripts = dirname(fileURLToPath(import.meta.url));
const guardDir = join(scripts, "guard");
const outer = "http://127.0.0.1:23105";
const owner = "https://owner.example";
const noTmux =
  spawnSync("tmux", ["-V"]).status === 0 ? false : "tmux is not installed on this machine";

/**
 * A HOME with an optional CLI config, a private directory with an optional tunnel, and a fake real
 * `mend` after the guard on PATH that prints its argv and the config home it was given.
 */
const world = ({ xdgUrl, legacyUrl, tunnelPort } = {}) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-")));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "mend"), '#!/bin/sh\necho "real mend $* · config $XDG_CONFIG_HOME"\n');
  chmodSync(join(bin, "mend"), 0o755);
  const xdg = join(home, "xdg");
  mkdirSync(xdg);
  if (xdgUrl !== undefined) {
    mkdirSync(join(xdg, "mend"));
    writeFileSync(join(xdg, "mend", "cli.json"), JSON.stringify({ url: xdgUrl, token: "t" }));
  }
  if (legacyUrl !== undefined) {
    mkdirSync(join(home, ".mend"));
    writeFileSync(join(home, ".mend", "cli.json"), JSON.stringify({ url: legacyUrl }));
  }
  const P = join(home, "private");
  mkdirSync(P);
  if (tunnelPort !== undefined) tunnelTo(P, tunnelPort);
  return { home, bin, xdg, P };
};

// The guard gives the real CLI a home of the run's own under ~/.cache/mend-verify/home: every one
// these tests make goes again at the end.
const runHomes = new Set();
after(() => {
  for (const home of runHomes) rmSync(home, { recursive: true, force: true });
});
const track = (xdg) => {
  try {
    runHomes.add(runHome(realpathSync(xdg)));
  } catch {
    // An XDG home that does not exist is refused before any home is made.
  }
};

const run = (w, args = ["projects"], env = {}, cwd = w.home) => {
  const xdg = "XDG_CONFIG_HOME" in env ? env.XDG_CONFIG_HOME : w.xdg;
  if (xdg?.startsWith("/")) track(xdg);
  return spawnSync(join(guardDir, "mend"), args, {
    encoding: "utf8",
    cwd,
    env: {
      PATH: `${guardDir}:${w.bin}:${process.env.PATH}`,
      HOME: w.home,
      XDG_CONFIG_HOME: w.xdg,
      MEND_VERIFY_PRIVATE: w.P,
      // The CLI the guard runs: this world's fake, never a mend on PATH.
      MEND_VERIFY_REAL_MEND: join(w.bin, "mend"),
      ...env,
    },
  });
};

const within = (options, body) => {
  const w = world(options);
  try {
    body(w);
  } finally {
    rmSync(w.home, { recursive: true, force: true });
  }
};

const refused = (result, reason) => {
  assert.equal(result.status, 97, result.stderr);
  assert.match(result.stderr, /a verifier never talks to the owner's server/);
  if (reason) assert.match(result.stderr, reason);
  assert.doesNotMatch(result.stdout, /real mend/);
};

test("the guard refuses without a declared outer server", () => {
  within({ xdgUrl: outer }, (w) => refused(run(w), /MEND_VERIFY_OUTER_URL is not set/));
});

test("the guard refuses a config that names another server, or none", () => {
  for (const xdgUrl of [owner, ""])
    within({ xdgUrl }, (w) => refused(run(w, ["projects"], { MEND_VERIFY_OUTER_URL: outer })));
});

test("the guard refuses MEND_URL and MEND_TOKEN overrides", () => {
  within({ xdgUrl: outer }, (w) => {
    refused(run(w, ["projects"], { MEND_VERIFY_OUTER_URL: outer, MEND_URL: outer }));
    refused(run(w, ["projects"], { MEND_VERIFY_OUTER_URL: outer, MEND_TOKEN: "x" }));
  });
});

test("the guard refuses when the CLI would read the legacy ~/.mend", () => {
  // No mend/ under XDG_CONFIG_HOME: the CLI falls back to ~/.mend.
  within({ legacyUrl: outer }, (w) =>
    refused(run(w, ["projects"], { MEND_VERIFY_OUTER_URL: outer }), /\.mend/),
  );
});

test("the guard runs the CLI it was given for the declared outer server", () => {
  within({ xdgUrl: `${outer}/` }, (w) => {
    const result = run(w, ["projects"], { MEND_VERIFY_OUTER_URL: outer });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `real mend projects · config ${w.xdg}`);
  });
});

// F2: an argument the CLI dials ahead of its config.
test("the guard refuses a --url or --server that names another server, login included", () => {
  within({ xdgUrl: outer }, (w) => {
    const env = { MEND_VERIFY_OUTER_URL: outer };
    for (const args of [
      ["login", "--url", owner],
      ["login", `--url=${owner}`],
      ["login", "--url"],
      ["login", "--", "--url", owner],
      ["pair", "--url", "http://localhost:3105"],
      ["projects", "--server", owner],
      ["run", "--url", owner, "--", "true"],
    ])
      refused(run(w, args, env), /--url|--server/);
    const login = run(w, ["login", "--url", `${outer}/`], env);
    assert.equal(login.status, 0, login.stderr);
    // After a runner's `--` the words are the workspace command's, not the CLI's.
    const inner = run(w, ["run", "--project", "mend", "--", "mend", "login", "--url", owner], env);
    assert.equal(inner.status, 0, inner.stderr);
  });
});

test("the guard refuses commands that act on this machine's own Mend installation", () => {
  within({ xdgUrl: outer }, (w) => {
    const env = { MEND_VERIFY_OUTER_URL: outer };
    for (const args of [
      ["server", "status"],
      ["server", "setup"],
      ["uninstall", "--server", "--yes"],
    ])
      refused(run(w, args, env), /this machine's own Mend installation/);
    assert.equal(run(w, ["server", "setup", "--help"], env).status, 0);
  });
});

// F3: the config home, as the real CLI will resolve it.
test("the guard refuses a relative, missing or unset XDG_CONFIG_HOME", () => {
  within({ xdgUrl: outer }, (w) => {
    const env = { MEND_VERIFY_OUTER_URL: outer };
    refused(run(w, ["--version"], { ...env, XDG_CONFIG_HOME: "xdg" }, w.home), /relative/);
    refused(
      run(w, ["--version"], {
        ...env,
        XDG_CONFIG_HOME: join(w.home, "nowhere"),
      }),
      /does not exist/,
    );
    refused(run(w, ["--version"], { ...env, XDG_CONFIG_HOME: "" }), /not set/);
  });
});

test("the guard refuses this machine's own CLI config", () => {
  within({ legacyUrl: outer }, (w) => {
    mkdirSync(join(w.home, ".config", "mend"), { recursive: true });
    writeFileSync(join(w.home, ".config", "mend", "cli.json"), JSON.stringify({ url: outer }));
    const env = { MEND_VERIFY_OUTER_URL: outer };
    refused(
      run(w, ["projects"], {
        ...env,
        XDG_CONFIG_HOME: join(w.home, ".config"),
      }),
      /own CLI config/,
    );
    symlinkSync(join(w.home, ".config"), join(w.home, "alias"));
    refused(
      run(w, ["projects"], { ...env, XDG_CONFIG_HOME: join(w.home, "alias") }),
      /own CLI config/,
    );
  });
});

test("the guard pins the resolved, absolute config home for the real CLI", () => {
  within({ xdgUrl: outer, legacyUrl: owner }, (w) => {
    symlinkSync(w.xdg, join(w.home, "link"));
    const result = run(w, ["--version"], {
      MEND_VERIFY_OUTER_URL: outer,
      XDG_CONFIG_HOME: join(w.home, "link"),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `real mend --version · config ${w.xdg}`);
    // A shim that changes directory before the CLI starts still names the same config home.
    writeFileSync(
      join(w.bin, "mend"),
      `#!/bin/sh\ncd /\necho "real mend $* · config $XDG_CONFIG_HOME"\n`,
    );
    const shim = run(w, ["--version"], { MEND_VERIFY_OUTER_URL: outer });
    assert.equal(shim.stdout.trim(), `real mend --version · config ${w.xdg}`);
  });
});

test("the run's own tunnel is the only other server, and only while it is recorded", () => {
  const stack = "http://localhost:3325";
  within({ xdgUrl: stack, tunnelPort: 3325 }, (w) => {
    const env = { MEND_VERIFY_OUTER_URL: outer };
    assert.equal(run(w, ["projects"], env).status, 0);
    assert.equal(run(w, ["login", "--url", "http://127.0.0.1:3325"], env).status, 0);
    refused(run(w, ["login", "--url", "http://localhost:3105"], env));
    refused(run(w, ["projects"], { ...env, MEND_VERIFY_PRIVATE: "" }));
  });
  // A loopback URL alone is not the run's: the owner's own server may listen on this machine.
  within({ xdgUrl: "http://localhost:3105", tunnelPort: 3325 }, (w) =>
    refused(run(w, ["projects"], { MEND_VERIFY_OUTER_URL: outer })),
  );
});

// F1: no driver reaches a Mend client except through the guard.
const sources = readdirSync(scripts)
  .filter((name) => /\.(?:sh|mjs)$/.test(name) && !name.endsWith(".test.mjs"))
  .map((name) => ({ name, text: readFileSync(join(scripts, name), "utf8") }));

test("no driver puts a mend on PATH, or a PATH that does not start with the guard", () => {
  for (const { name, text } of sources) {
    const lines = text.split("\n").filter((line) => !/^\s*(?:#|\/\/|\*)/.test(line));
    for (const line of lines) {
      assert.doesNotMatch(
        line,
        /(?:>|\b(?:ln|cp|mv|chmod|install)\b[^;|]*?)\s*"?[^"\s;|]*\/bin\/mend\b/,
        `${name} writes a mend into a bin directory: ${line}`,
      );
      for (const [, first] of line.matchAll(/\bPATH=([^:]*)/g))
        assert.match(
          first,
          /guard/,
          `${name} sets a PATH that does not start with the guard: ${line}`,
        );
      if (
        /apps\/cli|dist\/main\.js|src\/main\.ts/.test(line) &&
        !/\/real\/mend|apps\/cli" && pwd|entryPoints:/.test(line)
      )
        assert.fail(
          `${name} reaches the CLI's entry point outside the guard's real/ launcher: ${line}`,
        );
    }
    for (const [, command] of text.matchAll(
      /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["'`]([^"'`]*)["'`]/g,
    ))
      if (/mend/.test(command))
        assert.equal(command, "mend", `${name} runs ${command}, not the mend on PATH (the guard)`);
  }
});

const tui = (w, args, env = {}) =>
  spawnSync("sh", [join(scripts, "drive-tui.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: w.home,
      XDG_CACHE_HOME: join(w.home, "cache"),
      TMUX_TMPDIR: w.home,
      MEND_VERIFY_PRIVATE: w.P,
      MEND_VERIFY_OUTER_URL: outer,
      ...env,
    },
  });

/**
 * A built terminal bundle whose CLI only says it was reached; `stale` adds the unguarded
 * bin/mend an older build left (the one the review's probe reached).
 */
const fakeBundle = (w, { stale = false } = {}) => {
  const bundle = join(w.home, "cache", "mend-verify", "tui-cli-bundle");
  mkdirSync(join(bundle, "real"), { recursive: true });
  mkdirSync(join(bundle, "bin"), { recursive: true });
  for (const at of stale ? ["real", "bin"] : ["real"]) {
    writeFileSync(join(bundle, at, "mend"), '#!/bin/sh\necho "BUNDLED CLI REACHED $*"\n');
    chmodSync(join(bundle, at, "mend"), 0o755);
  }
  writeFileSync(join(w.P, "account.json"), JSON.stringify({ token: "tok-1234567890" }));
};
const killTmux = (w) =>
  spawnSync("tmux", ["-L", "st-verify-tui", "kill-server"], {
    env: { ...process.env, TMUX_TMPDIR: w.home },
  });

test("the terminal driver refuses a server other than the run's tunnel, before any terminal starts", () => {
  within({ tunnelPort: 3325 }, (w) => {
    fakeBundle(w, { stale: true });
    try {
      for (const [web, env] of [
        [owner, {}],
        [owner, { MEND_VERIFY_OUTER_URL: "" }],
        ["http://localhost:3105", {}],
        ["http://localhost:3325", { MEND_VERIFY_OUTER_URL: "" }],
      ]) {
        const result = tui(w, ["start", "t", web, "--", "mend", "ui"], env);
        assert.equal(result.status, 97, `${web}: ${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /a verifier never talks to the owner's server/);
      }
    } finally {
      killTmux(w);
    }
  });
});

test("every mend in the terminal passes the guard", { skip: noTmux }, () => {
  within({ tunnelPort: 3325 }, (w) => {
    fakeBundle(w);
    const capture = (name) => {
      for (let i = 0; i < 40; i += 1) {
        const pane = spawnSync(
          "tmux",
          ["-L", "st-verify-tui", "capture-pane", "-p", "-t", `st-verify-tui-${name}`],
          {
            encoding: "utf8",
            env: { ...process.env, TMUX_TMPDIR: w.home },
          },
        ).stdout;
        if (/drive-tui: command ended/.test(pane)) return pane;
        spawnSync("sleep", ["0.25"]);
      }
      return "";
    };
    try {
      assert.equal(
        tui(w, ["start", "ok", "http://localhost:3325", "--", "mend", "projects"]).status,
        0,
      );
      track(join(w.P, "tui-cli"));
      assert.match(capture("ok"), /BUNDLED CLI REACHED projects/);
      assert.equal(
        tui(w, ["start", "no", "http://localhost:3325", "--", "mend", "login", "--url", owner])
          .status,
        0,
      );
      const refusedPane = capture("no");
      assert.match(refusedPane, /refused/);
      assert.doesNotMatch(refusedPane, /BUNDLED CLI REACHED/);
      // A bundle an older build left, with its unguarded bin/mend, is refused.
      fakeBundle(w, { stale: true });
      const stale = tui(w, ["start", "stale", "http://localhost:3325", "--", "mend", "projects"]);
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /older build/);
    } finally {
      killTmux(w);
    }
  });
});

test("the desktop and mobile drivers refuse a server other than the run's tunnel", () => {
  within({ tunnelPort: 3325 }, (w) => {
    const app = join(w.home, "app");
    mkdirSync(join(app, "out", "main"), { recursive: true });
    writeFileSync(join(app, "out", "main", "index.js"), "");
    const env = {
      ...process.env,
      HOME: w.home,
      MEND_VERIFY_PRIVATE: w.P,
      MEND_VERIFY_OUTER_URL: outer,
    };
    const desktop = spawnSync(
      "sh",
      [join(scripts, "drive-desktop.sh"), "start", app, owner, "9399", ":199"],
      { encoding: "utf8", env },
    );
    assert.equal(desktop.status, 97, desktop.stderr);
    const mobile = spawnSync(
      process.execPath,
      [
        join(scripts, "drive-mobile.mjs"),
        "--app",
        app,
        "--web",
        owner,
        "--port",
        "18999",
        "--log",
        join(w.home, "m.log"),
      ],
      { encoding: "utf8", env },
    );
    assert.equal(mobile.status, 97, mobile.stderr);
  });
});

test("a first mend login --url may make the run's own config, and nothing else may", () => {
  within({ legacyUrl: owner }, (w) => {
    const env = { MEND_VERIFY_OUTER_URL: outer };
    // No <config home>/mend yet: the CLI would write to ~/.mend.
    refused(run(w, ["login", "--url", outer], env), /\.mend/);
    mkdirSync(join(w.xdg, "mend"));
    const login = run(w, ["login", "--url", outer], env);
    assert.equal(login.status, 0, login.stderr);
    assert.equal(login.stdout.trim(), `real mend login --url ${outer} · config ${w.xdg}`);
    refused(run(w, ["login", "--url", owner], env), /--url/);
    refused(run(w, ["login"], env), /no CLI config/);
    refused(run(w, ["projects"], env), /no CLI config/);
  });
});

test("MEND_URL may name only loopback's discard port, where nothing answers", () => {
  within({ xdgUrl: outer }, (w) => {
    const env = { MEND_VERIFY_OUTER_URL: outer };
    assert.equal(run(w, ["version"], { ...env, MEND_URL: "http://127.0.0.1:9" }).status, 0);
    for (const url of ["http://127.0.0.1:90", "http://localhost:9", outer, owner])
      refused(run(w, ["version"], { ...env, MEND_URL: url }), /MEND_URL is set/);
  });
});

// F10: HOME is the environment's; the account's home in the password database is not.
test("a changed HOME does not make the account's own config a run's", () => {
  const passwd = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-passwd-")));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-home-")));
  try {
    mkdirSync(join(passwd, ".config", "mend"), { recursive: true });
    writeFileSync(join(passwd, ".config", "mend", "cli.json"), JSON.stringify({ url: outer }));
    const env = { MEND_VERIFY_OUTER_URL: outer };
    const homes = [elsewhere, passwd];
    const refusedBy = (xdg) =>
      assert.throws(
        () => checkCli(["run", "--", "true"], { ...env, XDG_CONFIG_HOME: xdg }, homes),
        (error) => error instanceof Refused && /own CLI config/.test(error.message),
      );
    refusedBy(join(passwd, ".config"));
    // Under it, or reached through a link: the directory, or the file alone.
    mkdirSync(join(passwd, ".config", "mend", "nested", "mend"), { recursive: true });
    writeFileSync(
      join(passwd, ".config", "mend", "nested", "mend", "cli.json"),
      JSON.stringify({ url: outer }),
    );
    refusedBy(join(passwd, ".config", "mend", "nested"));
    mkdirSync(join(elsewhere, "linked"));
    symlinkSync(join(passwd, ".config", "mend"), join(elsewhere, "linked", "mend"));
    refusedBy(join(elsewhere, "linked"));
    mkdirSync(join(elsewhere, "file", "mend"), { recursive: true });
    symlinkSync(
      join(passwd, ".config", "mend", "cli.json"),
      join(elsewhere, "file", "mend", "cli.json"),
    );
    refusedBy(join(elsewhere, "file"));
  } finally {
    rmSync(passwd, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// The reported bypass, through the guard itself, on a machine whose account has a CLI config. Only
// the directory's presence is looked at: the refusal comes before any config is read, and the real
// CLI is a fake that only echoes.
const accountConfigDir = join(userInfo().homedir, ".config", "mend");
test(
  "the guard refuses the account's own config under another HOME",
  { skip: existsSync(accountConfigDir) ? false : "this account has no ~/.config/mend" },
  () => {
    within({}, (w) => {
      const result = run(w, ["run", "--", "true"], {
        HOME: w.home,
        XDG_CONFIG_HOME: join(userInfo().homedir, ".config"),
        MEND_VERIFY_OUTER_URL: outer,
        MEND_VERIFY_REAL_MEND: join(w.bin, "mend"),
      });
      refused(result, /own CLI config/);
    });
  },
);

test("a run's own config in a directory of its own passes, under the real HOME or another", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "st-guard-")));
  try {
    const alpha = "https://alpha.mend.run";
    mkdirSync(join(dir, "mend-cli", "mend"), { recursive: true });
    writeFileSync(
      join(dir, "mend-cli", "mend", "cli.json"),
      JSON.stringify({ url: alpha, token: "t" }),
    );
    within({}, (w) => {
      for (const HOME of [process.env.HOME ?? userInfo().homedir, w.home]) {
        const result = run(w, ["projects"], {
          HOME,
          XDG_CONFIG_HOME: join(dir, "mend-cli"),
          MEND_VERIFY_OUTER_URL: alpha,
          MEND_VERIFY_REAL_MEND: join(w.bin, "mend"),
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), `real mend projects · config ${join(dir, "mend-cli")}`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review round 2, R2-1: inside a Mend session the next `mend` on PATH is the session's own helper,
// which ignores the config and acts on the session. Main's real helper, staged here, against a
// loopback stub playing the session's server; the token is synthetic.
const repoRoot = join(scripts, "..", "..", "..", "..");
const { SESSION_HELPER_SCRIPT } = await import(
  join(repoRoot, "packages", "sessions", "src", "session-socket.ts")
);

/** A loopback stub for the session's server, in a process of its own, logging each request. */
const sessionStub = async (log) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const http = require("node:http"), fs = require("node:fs");
       const server = http.createServer((req, res) => {
         fs.appendFileSync(process.argv[1], req.method + " " + req.url + "\\n");
         req.resume();
         req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(req.url.includes("services") ? "[]" : "{}"); });
       });
       server.listen(0, "127.0.0.1", () => console.log(server.address().port));`,
      log,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const port = await new Promise((done) =>
    child.stdout.once("data", (data) => done(String(data).trim())),
  );
  return { child, url: `http://127.0.0.1:${port}` };
};

test("inside a session the guard never runs the session's helper, and the session hears nothing", async () => {
  const w = world({ xdgUrl: outer });
  const log = join(w.home, "session-requests.log");
  writeFileSync(log, "");
  const { child, url } = await sessionStub(log);
  try {
    const helperDir = join(w.home, "helper");
    mkdirSync(helperDir);
    writeFileSync(join(helperDir, "mend"), SESSION_HELPER_SCRIPT, { mode: 0o755 });
    writeFileSync(join(w.home, "wrapper"), `#!/bin/sh\nexec ${join(helperDir, "mend")} "$@"\n`, {
      mode: 0o755,
    });
    const session = {
      MEND_VERIFY_OUTER_URL: outer,
      MEND_SESSION_ENDPOINT: url,
      MEND_SESSION_ID: "owner-session",
      MEND_SESSION_TOKEN: "synthetic-session-token-0000",
      PATH: `${guardDir}:${helperDir}:${process.env.PATH}`,
    };
    for (const args of [["stop"], ["service", "list"], ["land"]]) {
      refused(
        run(w, args, { ...session, MEND_VERIFY_REAL_MEND: join(helperDir, "mend") }),
        /in-workspace helper/,
      );
      refused(
        run(w, args, { ...session, MEND_VERIFY_REAL_MEND: join(w.home, "wrapper") }),
        /in-workspace helper/,
      );
    }
    // With no CLI named, the guard runs this checkout's own apps/cli, never the helper first on
    // PATH (resolved here, not run).
    assert.deepEqual(realCli({ PATH: session.PATH }, guardDir), {
      file: process.execPath,
      args: [realpathSync(join(repoRoot, "apps", "cli", "src", "main.ts"))],
    });
    // The CLI the run names runs, with no session variable in its environment.
    writeFileSync(
      join(w.bin, "env-mend"),
      '#!/bin/sh\nenv | grep "^MEND_SESSION_" || echo "no session variables"\n',
      { mode: 0o755 },
    );
    const named = run(w, ["projects"], {
      ...session,
      MEND_VERIFY_REAL_MEND: join(w.bin, "env-mend"),
    });
    assert.equal(named.status, 0, named.stderr);
    assert.equal(named.stdout.trim(), "no session variables");
    assert.equal(readFileSync(log, "utf8"), "", "the session's server was reached");
  } finally {
    child.kill();
    rmSync(w.home, { recursive: true, force: true });
  }
});

// R2-3: this machine's own config by identity, not only by path. Synthetic homes and tokens.
test("a copy, a hard link, or the owner's config under a recorded XDG home is the owner's", () => {
  const passwd = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-passwd-")));
  const runs = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-runs-")));
  try {
    const owner = JSON.stringify({
      url: outer,
      token: "owner-token-0123456789",
      deviceId: "owner-device-0123",
    });
    mkdirSync(join(passwd, ".config", "mend"), { recursive: true });
    writeFileSync(join(passwd, ".config", "mend", "cli.json"), owner);
    const config = (name, write) => {
      mkdirSync(join(runs, name, "mend"), { recursive: true });
      write(join(runs, name, "mend", "cli.json"));
      return join(runs, name);
    };
    const check =
      (xdg, env = {}) =>
      () =>
        checkCli(["projects"], { MEND_VERIFY_OUTER_URL: outer, XDG_CONFIG_HOME: xdg, ...env }, [
          runs,
          passwd,
        ]);
    const ownersBy = (pattern) => (error) =>
      error instanceof Refused && pattern.test(error.message);
    assert.throws(check(config("copy", (file) => writeFileSync(file, owner))), ownersBy(/copy/));
    const device = JSON.stringify({
      url: outer,
      token: "another-token-0123456",
      deviceId: "owner-device-0123",
    });
    assert.throws(check(config("device", (file) => writeFileSync(file, device))), ownersBy(/copy/));
    assert.throws(
      check(config("hard", (file) => linkSync(join(passwd, ".config", "mend", "cli.json"), file))),
      ownersBy(/same file/),
    );
    // The owner's own config kept under their own XDG home, recorded by Launch: by path.
    const elsewhere = JSON.stringify({
      url: outer,
      token: "owner-xdg-token-0123456",
      deviceId: "owner-xdg-device-01",
    });
    const dotconfig = config("dotconfig", (file) => writeFileSync(file, elsewhere));
    assert.throws(
      check(dotconfig, { MEND_VERIFY_MACHINE_XDG: dotconfig }),
      ownersBy(/own CLI config/),
    );
    const mine = JSON.stringify({
      url: outer,
      token: "a-run-token-0123456789",
      deviceId: "run-device-0123",
    });
    const ok = config("mine", (file) => writeFileSync(file, mine));
    assert.equal(check(ok)(), ok);
  } finally {
    rmSync(passwd, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
});

// R2-4: the real CLI never sees this machine's home, logins, agent or session.
test("the real CLI runs in a home of the run's own, with no login or provider variable", () => {
  within({ xdgUrl: outer }, (w) => {
    writeFileSync(join(w.bin, "env-mend"), "#!/bin/sh\nenv\n", { mode: 0o755 });
    const leaked = {
      GH_TOKEN: "gho_synthetic0000000000000000000000",
      GITHUB_TOKEN: "ghp_synthetic0000000000000000000000",
      GH_CONFIG_DIR: join(w.home, "owner-gh"),
      ANTHROPIC_API_KEY: "sk-ant-synthetic-000000000000",
      OPENAI_API_KEY: "sk-synthetic-0000000000000000000000",
      CLAUDE_CONFIG_DIR: join(w.home, "owner-claude"),
      CODEX_HOME: join(w.home, "owner-codex"),
      SSH_AUTH_SOCK: join(w.home, "agent.sock"),
      MEND_URL: "http://127.0.0.1:9",
    };
    const result = run(w, ["connect", "github", "--from-stdin"], {
      MEND_VERIFY_OUTER_URL: outer,
      MEND_VERIFY_REAL_MEND: join(w.bin, "env-mend"),
      ...leaked,
    });
    assert.equal(result.status, 0, result.stderr);
    const env = Object.fromEntries(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const home = env.HOME;
    try {
      assert.ok(
        home.startsWith(join(userInfo().homedir, ".cache", "mend-verify", "home") + "/"),
        home,
      );
      assert.equal(env.CLAUDE_CONFIG_DIR, join(home, ".claude"));
      assert.equal(env.CODEX_HOME, join(home, ".codex"));
      assert.equal(env.GH_CONFIG_DIR, join(home, ".config", "gh"));
      for (const name of [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "SSH_AUTH_SOCK",
      ])
        assert.equal(env[name], undefined, `${name} reached the CLI`);
      assert.equal(env.MEND_URL, "http://127.0.0.1:9");
      assert.equal(env.XDG_CONFIG_HOME, w.xdg);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// H3: `gh auth token` with an empty GH_CONFIG_DIR still reads the owner's login from the OS keyring,
// through the secret service on the session D-Bus.
test("mend connect github needs --from-stdin under the guard: gh would read this machine's login", () => {
  within({ xdgUrl: outer }, (w) => {
    const env = { MEND_VERIFY_OUTER_URL: outer };
    refused(run(w, ["connect", "github"], env), /gh auth token/);
    refused(run(w, ["connect", "github", "--use-my-login"], env), /--from-stdin/);
    for (const args of [
      ["connect", "github", "--from-stdin"],
      ["connect", "github", "--remove"],
      ["connect", "github", "--help"],
      ["connect", "codex", "--from-stdin"],
      ["run", "--project", "mend", "--", "mend", "connect", "github"],
    ]) {
      const result = run(w, args, env);
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    }
  });
});

/**
 * A `gh` that looks for the keyring the way gh's keyring library does on Linux: the session bus at
 * DBUS_SESSION_BUS_ADDRESS (empty or `autolaunch:` means look on), else $XDG_RUNTIME_DIR/bus, and
 * connects to it. It prints what it reached, and the keyring agents' variables it was handed.
 */
const KEYRING_GH = `#!/usr/bin/env node
const { existsSync } = require("node:fs");
const net = require("node:net");
const address = process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
const runtime = process.env.XDG_RUNTIME_DIR ?? "";
const path =
  address !== "" && address !== "autolaunch:"
    ? (/unix:path=([^,;]+)/.exec(address) ?? [])[1]
    : runtime !== "" && existsSync(runtime + "/bus")
      ? runtime + "/bus"
      : undefined;
const agents = Object.keys(process.env).filter((name) =>
  /^(?:GNOME_KEYRING_|KWALLET|GPG_AGENT_INFO$|SSH_AGENT_PID$|SSH_AUTH_SOCK$|OP_|BW_SESSION$)/.test(name),
);
const done = (line) => {
  console.log(line + " · agents " + (agents.join(",") || "none"));
  process.exit(line.startsWith("keyring reached") ? 0 : 1);
};
if (path === undefined) done("no D-Bus · nothing to look at");
const socket = net.connect(path);
socket.on("connect", () => done("keyring reached " + path));
socket.on("error", (error) => done("no D-Bus · " + error.code));
`;

test("under the guard, a gh that tries the keyring finds no D-Bus and no keyring agent", async () => {
  const w = world({ xdgUrl: outer });
  const servers = [];
  try {
    writeFileSync(join(w.bin, "gh"), KEYRING_GH, { mode: 0o755 });
    // The real CLI as `mend connect github` is without --from-stdin: it runs `gh auth token`.
    writeFileSync(join(w.bin, "gh-mend"), "#!/bin/sh\nexec gh auth token\n", { mode: 0o755 });
    // The owner's session bus, and the runtime directory's `bus` a D-Bus client tries next.
    const runtime = join(w.home, "owner-run");
    mkdirSync(runtime, { mode: 0o700 });
    const reached = [];
    for (const path of [join(w.home, "owner-bus"), join(runtime, "bus")]) {
      const server = createServer((socket) => {
        reached.push(path);
        socket.destroy();
      });
      await new Promise((done) => server.listen(path, done));
      servers.push(server);
    }
    const owner = {
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(w.home, "owner-bus")},guid=0123456789abcdef`,
      DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${join(w.home, "owner-bus")}`,
      XDG_RUNTIME_DIR: runtime,
      GNOME_KEYRING_CONTROL: join(runtime, "keyring"),
      GNOME_KEYRING_PID: "4242",
      KWALLET_SESSION: "kwallet6",
      GPG_AGENT_INFO: join(runtime, "gnupg", "S.gpg-agent"),
      SSH_AGENT_PID: "4243",
      SSH_AUTH_SOCK: join(runtime, "ssh-agent.sock"),
      OP_SESSION_owner: "synthetic-op-session",
      BW_SESSION: "synthetic-bw-session",
    };
    const gh = (command, env) =>
      new Promise((done) => {
        const child = spawn(command[0], command.slice(1), { cwd: w.home, env });
        let out = "";
        child.stdout.on("data", (data) => (out += data));
        child.stderr.on("data", (data) => (out += data));
        child.on("exit", (status) => done({ status, out }));
      });
    const base = {
      PATH: `${guardDir}:${w.bin}:${process.env.PATH}`,
      HOME: w.home,
      XDG_CONFIG_HOME: w.xdg,
      MEND_VERIFY_PRIVATE: w.P,
      MEND_VERIFY_OUTER_URL: outer,
      ...owner,
    };
    // Without the guard, the same gh reaches the owner's bus: the stub can tell.
    const bare = await gh([join(w.bin, "gh"), "auth", "token"], base);
    assert.match(bare.out, /keyring reached/, bare.out);
    assert.equal(reached.length, 1);
    reached.length = 0;
    // Under the guard: no bus, no runtime `bus`, no agent.
    track(w.xdg);
    const guarded = await gh([join(guardDir, "mend"), "connect", "github", "--from-stdin"], {
      ...base,
      MEND_VERIFY_REAL_MEND: join(w.bin, "gh-mend"),
    });
    assert.equal(guarded.status, 1, guarded.out);
    assert.match(guarded.out, /^no D-Bus · ENOENT · agents none$/m, guarded.out);
    assert.deepEqual(reached, []);
  } finally {
    for (const server of servers) server.close();
    rmSync(w.home, { recursive: true, force: true });
  }
});

// R2-2: a tunnel counts only when its own child holds the port.
/**
 * A port below the kernel's ephemeral range that nothing holds, its probe closed before it returns.
 * Never port 0: the other test files, running beside this one, take their ports from the ephemeral
 * range, and one of them could take a port between this pick and the tunnel's bind.
 */
const quietPort = async () => {
  let low = 32768;
  try {
    low = Number(
      readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0],
    );
  } catch {
    // Not Linux: the usual default.
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * Math.max(1, low - 20000));
    const free = await new Promise((done) => {
      const probe = createServer();
      probe.once("error", () => done(false));
      probe.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
        probe.close(() => done(true)),
      );
    });
    if (free) return port;
  }
  throw new Error("no free port below the ephemeral range");
};

/** A `mend` whose `service connect … --port <p>` listens on 127.0.0.1:<p> and answers health. */
const FAKE_CONNECT = `#!/usr/bin/env node
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
require("node:http").createServer((req, res) => res.end("{}")).listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

test("a tunnel counts only when its own child holds the port", async () => {
  const w = world({});
  writeFileSync(join(w.bin, "mend"), FAKE_CONNECT, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${w.bin}:${process.env.PATH}`,
    MEND_VERIFY_OUTER_URL: outer,
  };
  const tunnel = (...args) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [join(scripts, "tunnel.mjs"), ...args], { env });
      let out = "";
      child.stdout.on("data", (data) => (out += data));
      child.stderr.on("data", (data) => (out += data));
      child.on("exit", (status) => done({ status, out }));
    });
  const target = (port) => () =>
    checkTarget(`http://localhost:${port}`, {
      MEND_VERIFY_OUTER_URL: outer,
      MEND_VERIFY_PRIVATE: w.P,
    });
  const squatPort = await quietPort();
  const squatter = spawn(process.execPath, [
    "-e",
    `require("node:http").createServer((q, r) => r.end("{}")).listen(${squatPort}, "127.0.0.1", () => console.log("up"))`,
  ]);
  try {
    await new Promise((done) => squatter.stdout.once("data", done));
    // Something else answers health there (the owner's own tunnel, say): refused before any spawn.
    const taken = await tunnel(
      "start",
      "--service",
      "s",
      "--port",
      String(squatPort),
      "--dir",
      w.P,
      "--log",
      join(w.home, "t.log"),
    );
    assert.equal(taken.status, 1, taken.out);
    assert.match(taken.out, /taken/);
    assert.ok(!existsSync(join(w.P, "tunnel.json")));
    assert.throws(target(squatPort), Refused);
    // Its own child's listener: bound, allowed while it lives, refused once stopped.
    const port = await quietPort();
    const own = await tunnel(
      "start",
      "--service",
      "s",
      "--port",
      String(port),
      "--dir",
      w.P,
      "--log",
      join(w.home, "t.log"),
    );
    assert.equal(own.status, 0, own.out);
    assert.equal(JSON.parse(readFileSync(join(w.P, "tunnel.json"), "utf8")).bound, true);
    assert.equal(target(port)(), `http://localhost:${port}`);
    assert.throws(
      () =>
        checkTarget(`http://[::1]:${port}`, {
          MEND_VERIFY_OUTER_URL: outer,
          MEND_VERIFY_PRIVATE: w.P,
        }),
      Refused,
    );
    assert.equal((await tunnel("stop", "--dir", w.P)).status, 0);
    for (
      let i = 0;
      i < 50 && identityOf(JSON.parse(readFileSync(join(w.P, "tunnel.json"), "utf8")).pid);
      i += 1
    )
      await new Promise((done) => setTimeout(done, 100));
    assert.throws(target(port), Refused);
  } finally {
    squatter.kill();
    rmSync(w.home, { recursive: true, force: true });
  }
});

// H2: drive-web.mjs drives the mobile proxy drive-mobile.mjs started in front of the run's tunnel,
// and no other.
test("drive-web may drive the mobile proxy this run started, and no other", async () => {
  const w = world({});
  // Expo is not what is under test: a pnpm that exits.
  writeFileSync(join(w.bin, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const app = join(w.home, "app");
  mkdirSync(app);
  const tunnelPort = await quietPort();
  tunnelTo(w.P, tunnelPort);
  const env = {
    ...process.env,
    PATH: `${w.bin}:${process.env.PATH}`,
    MEND_VERIFY_PRIVATE: w.P,
    MEND_VERIFY_OUTER_URL: outer,
  };
  const policyEnv = { MEND_VERIFY_OUTER_URL: outer, MEND_VERIFY_PRIVATE: w.P };
  const target = (url, mobile) => () => checkTarget(url, policyEnv, { mobile });
  const driveWeb = (url) =>
    spawnSync(
      process.execPath,
      [
        join(scripts, "drive-web.mjs"),
        "--web",
        url,
        "--out",
        join(w.home, "out"),
        "--recipe",
        join(w.home, "none.mjs"),
        "--private",
        w.P,
      ],
      { encoding: "utf8", env: { ...env, MEND_VERIFY_PLAYWRIGHT: join(w.home, "no-playwright") } },
    );
  const mobilePort = await quietPort();
  const mobileArgs = (web) => [
    join(scripts, "drive-mobile.mjs"),
    "--app",
    app,
    "--web",
    web,
    "--port",
    String(mobilePort),
    "--log",
    join(w.home, "mobile.log"),
  ];
  const record = join(w.P, "mobile.json");
  let proxy;
  try {
    // Before any proxy: refused.
    assert.throws(target(`http://127.0.0.1:${mobilePort}`, true), Refused);
    assert.equal(driveWeb(`http://127.0.0.1:${mobilePort}`).status, 97);
    // A proxy in front of the declared outer is no proxy of the run's: refused before it listens.
    const onOuter = spawnSync(process.execPath, mobileArgs(outer), { encoding: "utf8", env });
    assert.equal(onOuter.status, 97, onOuter.stderr);
    assert.ok(!existsSync(record));

    proxy = spawn(process.execPath, mobileArgs(`http://localhost:${tunnelPort}`), { env });
    await new Promise((done, fail) => {
      let out = "";
      proxy.stdout.on("data", (data) => {
        out += data;
        if (out.includes("drive-mobile ·")) done();
      });
      proxy.on("exit", (status) => fail(new Error(`drive-mobile exited ${status}: ${out}`)));
    });
    const recorded = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(recorded.pid, proxy.pid);
    assert.equal(recorded.bound, true);
    assert.equal(recorded.web, `http://localhost:${tunnelPort}`);

    // The run's own proxy, for drive-web only.
    assert.equal(target(`http://127.0.0.1:${mobilePort}`, true)(), `http://127.0.0.1:${mobilePort}`);
    assert.equal(target(`http://localhost:${mobilePort}`, true)(), `http://localhost:${mobilePort}`);
    assert.throws(target(`http://127.0.0.1:${mobilePort}`, false), Refused);
    assert.throws(target(`http://127.0.0.1:${mobilePort + 1}`, true), Refused);
    const allowed = driveWeb(`http://127.0.0.1:${mobilePort}`);
    assert.notEqual(allowed.status, 97, allowed.stderr);
    assert.doesNotMatch(allowed.stderr, /refused · a verifier/);
    // The guard and the terminal's check (`policy.mjs target`) never take it.
    const cli = spawnSync(
      process.execPath,
      [join(guardDir, "policy.mjs"), "target", `http://127.0.0.1:${mobilePort}`],
      { encoding: "utf8", env },
    );
    assert.equal(cli.status, 97, cli.stderr);

    // Once the run's tunnel is gone, the proxy in front of it no longer counts.
    tunnelTo(w.P, tunnelPort, { bound: false });
    assert.throws(target(`http://127.0.0.1:${mobilePort}`, true), Refused);
    tunnelTo(w.P, tunnelPort);

    // A record drive-mobile did not write, or that fronts another server, counts for nothing.
    const forged = (fields) =>
      writeFileSync(
        record,
        JSON.stringify({
          pid: proxy.pid,
          identity: identityOf(proxy.pid),
          port: String(mobilePort),
          web: `http://localhost:${tunnelPort}`,
          bound: true,
          ...fields,
        }),
      );
    forged({ web: owner });
    assert.throws(target(`http://127.0.0.1:${mobilePort}`, true), Refused);
    forged({ bound: false });
    assert.throws(target(`http://127.0.0.1:${mobilePort}`, true), Refused);
    forged({ identity: "Thu Jan  1 00:00:00 1970" });
    assert.throws(target(`http://127.0.0.1:${mobilePort}`, true), Refused);
    forged({});

    // The proxy ends: its record goes, and its port is refused again.
    const ended = new Promise((done) => proxy.once("exit", done));
    proxy.kill("SIGTERM");
    await ended;
    proxy = undefined;
    assert.ok(!existsSync(record));
    assert.throws(target(`http://127.0.0.1:${mobilePort}`, true), Refused);
  } finally {
    proxy?.kill("SIGKILL");
    rmSync(w.home, { recursive: true, force: true });
  }
});
