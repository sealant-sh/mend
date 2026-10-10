// The guard and its policy (guard/mend, guard/policy.mjs), and every driver's way to a Mend client:
// a verifier never talks to the owner's server. Node only; the terminal case needs tmux and is
// skipped, with that reason, where it is not installed.
//
//   node --test .claude/skills/verify/scripts/guard.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  if (tunnelPort !== undefined)
    writeFileSync(join(P, "tunnel.json"), JSON.stringify({ port: String(tunnelPort) }));
  return { home, bin, xdg, P };
};

const run = (w, args = ["projects"], env = {}, cwd = w.home) =>
  spawnSync(join(guardDir, "mend"), args, {
    encoding: "utf8",
    cwd,
    env: {
      PATH: `${guardDir}:${w.bin}:${process.env.PATH}`,
      HOME: w.home,
      XDG_CONFIG_HOME: w.xdg,
      MEND_VERIFY_PRIVATE: w.P,
      ...env,
    },
  });

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

test("the guard runs the next mend on PATH for the declared outer server", () => {
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
