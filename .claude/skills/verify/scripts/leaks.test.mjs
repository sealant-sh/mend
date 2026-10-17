// The verify skill's leak paths, each forced with a synthetic secret. The browser cases need the
// skill's Playwright (~/.cache/mend-verify/playwright, or $MEND_VERIFY_PLAYWRIGHT) and are skipped,
// with that reason, where it is not installed; the rest need only Node.
//
//   node --test .claude/skills/verify/scripts/leaks.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import {
  here,
  tunnelTo,
  skillMd,
  noBrowser,
  PASSWORD,
  TOKEN,
  SETUP_TOKEN,
  SECRET_FILE,
  chunk,
  metadataPng,
  fresh,
  everything,
  privateWithAccount,
  node,
  drive,
} from "./leaks.helpers.mjs";
import { loadSecrets, privateRoot, redactValues, register } from "./secrets.mjs";

test("a failing fill never prints the secret it was given", { skip: noBrowser }, () => {
  const privateDir = privateWithAccount();
  const out = fresh("evidence");
  // A recipe author's plain `fill` of a registered secret into a field that never takes it: Playwright's
  // error carries the argument in its call log.
  const run = drive(
    privateDir,
    out,
    `export default async ({ page }) => {
      await page.setContent('<label>Password <input id="p" type="password" disabled></label>');
      await page.getByLabel("Password").fill(${JSON.stringify(PASSWORD)});
    };`,
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /drive-web:/);
  assert.ok(!run.stderr.includes(PASSWORD), "the password reached stderr");
  assert.ok(run.stderr.includes("<secret>"), "the redaction is visible in its place");
  assert.ok(!everything(out).includes(PASSWORD), "the password reached the evidence");
});

test(
  "the account's password goes in by script, and a timed-out sign-in prints none of it",
  { skip: noBrowser },
  async () => {
    const privateDir = privateWithAccount();
    const out = fresh("evidence");
    // A login page whose Sign in leads nowhere: the drive times out after typing the password.
    const observed = [];
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/observation") {
        let body = "";
        request.on("data", (data) => (body += data));
        request.on("end", () => {
          for (const { event, value, disabled, email } of JSON.parse(body))
            observed.push({
              event,
              passwordMatches: value === PASSWORD,
              disabled,
              emailMatches: email === "verifier@verify-stack.invalid",
            });
          response.writeHead(204).end();
        });
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        `<label>Email <input name="email"></label><label>Password <input type="password" disabled></label><button>Sign in</button>
        <script>
          const password = document.querySelector('[type="password"]');
          const observations = [];
          const record = (event) => observations.push({ event, value: password.value,
            disabled: password.disabled, email: document.querySelector('[name="email"]').value });
          password.addEventListener('input', () => record('input'));
          password.addEventListener('change', () => record('change'));
          document.querySelector('button').addEventListener('click', () => {
            record('click');
            fetch('/observation', { method: 'POST', body: JSON.stringify(observations) });
          });
        </script>`,
      );
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const web = `http://127.0.0.1:${server.address().port}`;
    tunnelTo(privateDir, server.address().port);
    const recipePath = join(fresh("recipe"), "recipe.mjs");
    writeFileSync(recipePath, "export default async () => {};");
    // Asynchronous: the server above answers on this same event loop.
    const run = await new Promise((done) => {
      const child = spawn(
        process.execPath,
        [
          join(here, "drive-web.mjs"),
          "--web",
          web,
          "--out",
          out,
          "--recipe",
          recipePath,
          "--private",
          privateDir,
          "--account",
          join(privateDir, "account.json"),
          "--timeout",
          "1500",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (data) => (stderr += data));
      child.stdout.resume();
      child.on("close", (status) => done({ status, stderr }));
    }).finally(() => new Promise((done) => server.close(done)));
    assert.equal(run.status, 1);
    assert.deepEqual(
      observed,
      ["input", "change", "click"].map((event) => ({
        event,
        passwordMatches: true,
        disabled: true,
        emailMatches: true,
      })),
      "the disabled password field received the synthetic password before sign-in",
    );
    assert.match(run.stderr, /drive-web: page\.waitForURL: Timeout 1500ms exceeded/);
    assert.ok(!run.stderr.includes(PASSWORD), "the password reached stderr");
    assert.ok(!everything(out).includes(PASSWORD), "the password reached the evidence");
  },
);

test(
  "a typed setup token and secret-file contents stay out of snapshots and screenshots",
  { skip: noBrowser },
  () => {
    const privateDir = privateWithAccount();
    const out = fresh("evidence");
    // The product's own controls: the Claude token textarea (no label, a placeholder) and the secret
    // file's paste field (apps/web settings.tsx, secret-files-panel.tsx).
    const run = drive(
      privateDir,
      out,
      `export default async ({ page, capture, typeSecret }) => {
      await page.setContent(
        '<main><h1>Settings</h1>' +
        '<textarea placeholder="sk-ant-oat01-…  or  { &quot;claudeAiOauth&quot;: { … } }"></textarea>' +
        '<label>Or paste its text <textarea id="f"></textarea></label></main>');
      await typeSecret(page.getByPlaceholder(/sk-ant-oat01/), "claude-setup-token", ${JSON.stringify(SETUP_TOKEN)});
      await capture("claude-token");
      await typeSecret(page.getByLabel("Or paste its text"), "secret-file", ${JSON.stringify(SECRET_FILE)});
      await capture("secret-file");
    };`,
    );
    assert.equal(run.status, 0, run.stderr);
    const files = readdirSync(out);
    assert.ok(files.includes("claude-token.png.withheld") && !files.includes("claude-token.png"));
    assert.ok(files.includes("secret-file.png.withheld") && !files.includes("secret-file.png"));
    const all = everything(out);
    for (const value of [SETUP_TOKEN, "AKIAQ7XWZ3K9P2M4N6B8", "q8Rt5Lm2Np7Xv4Zw9Ab3Cd6Ef1Gh8Jk0"])
      assert.ok(!all.includes(value), `a typed secret reached the evidence`);
    // Both were registered, so the scan searches for them.
    const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
    assert.equal(scan.status, 0, scan.stdout);
    writeFileSync(
      join(out, "planted.txt"),
      `leak ${SETUP_TOKEN.slice(0, 30)} and AKIAQ7XWZ3K9P2M4N6B8`,
    );
    const planted = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
    assert.equal(planted.status, 1);
    assert.match(
      planted.stdout,
      /planted\.txt · a value from secrets\/(claude-setup-token|secret-file)\.[0-9a-f]{16}\.secret/,
    );
    assert.ok(!planted.stdout.includes("AKIAQ7XWZ3K9P2M4N6B8"), "the scan printed a value");
  },
);

test(
  "an unregistered value plainly filled into a credential field stays out of the evidence",
  { skip: noBrowser },
  () => {
    const privateDir = privateWithAccount();
    const out = fresh("evidence");
    // No registry entry and no known shape: only the field's name marks it as a credential.
    const shapeless = "zq81 plain words 77 shapeless-value";
    const run = drive(
      privateDir,
      out,
      `export default async ({ page, capture }) => {
      await page.setContent(
        '<main><textarea placeholder="sk-ant-oat01-…  or  { &quot;claudeAiOauth&quot;: { … } }"></textarea></main>');
      await page.getByPlaceholder(/sk-ant-oat01/).fill(${JSON.stringify(shapeless)});
      await capture("claude-token");
    };`,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(readdirSync(out).includes("claude-token.png.withheld"));
    assert.ok(!everything(out).includes(shapeless), "the value reached the evidence");
  },
);

test("malformed account state is reported without its contents", () => {
  const dir = fresh("handover");
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "cache"));
  mkdirSync(join(dir, "private"));
  writeFileSync(
    join(dir, "bin", "docker"),
    `#!/bin/sh\nfor a; do last=$a; done\ncase "$last" in */account.json) printf '%s' '{"password":"${PASSWORD}",';; */cli.json) echo '{"token":"${TOKEN}"}';; esac\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "cache", "stack.json"), JSON.stringify({ images: { cli: "x" } }));
  const key = node([
    join(here, "handover.mjs"),
    "keygen",
    "--dir",
    join(dir, "private"),
  ]).stdout.trim();
  const seal = node([join(here, "handover.mjs"), "seal", "--to", key], {
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      MEND_VERIFY_STACK_CACHE: join(dir, "cache"),
    },
  });
  assert.equal(seal.status, 1);
  assert.match(seal.stderr, /not valid JSON; nothing of it shown/);
  assert.ok(!`${seal.stdout}${seal.stderr}`.includes(PASSWORD), "the password was printed");
});

test("a planted hit fails Cleanup's last lines, deletes the leaking file and keeps the result", () => {
  // The three lines of SKILL.md's Cleanup that close the private directory, as written there.
  const lines = [
    'node $skill/scripts/scan-evidence.mjs --dir "$E" --secrets "$P" --delete-hits; scan=$?',
    'rm -rf "$P"',
    '[ "$scan" -eq 0 ] || { echo "verify: the evidence scan found a secret; those files are deleted ($E/scan.json): this run FAILED" >&2; exit 1; }',
  ];
  for (const line of lines) assert.ok(skillMd.includes(line), `SKILL.md no longer says: ${line}`);
  const P = privateWithAccount();
  const E = fresh("evidence");
  writeFileSync(join(E, "clean.txt"), "nothing here");
  writeFileSync(join(E, "leak.txt"), `oops ${PASSWORD}`);
  const run = spawnSync("bash", ["-c", lines.join("\n")], {
    encoding: "utf8",
    env: { ...process.env, skill: join(here, ".."), E, P },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /this run FAILED/);
  assert.ok(!existsSync(P), "the private directory was kept");
  assert.ok(!existsSync(join(E, "leak.txt")), "the leaking file was kept");
  assert.ok(existsSync(join(E, "clean.txt")));
  const result = JSON.parse(readFileSync(join(E, "scan.json"), "utf8"));
  assert.deepEqual(result.deleted, ["leak.txt"]);
  assert.ok(!readFileSync(join(E, "scan.json"), "utf8").includes(PASSWORD));
});

for (const { name, type, data } of [
  { name: "tEXt", type: "tEXt", data: (text) => Buffer.from(`Comment\0${text}`, "latin1") },
  {
    name: "zTXt",
    type: "zTXt",
    data: (text) => Buffer.concat([Buffer.from("Comment\0\0", "latin1"), deflateSync(text)]),
  },
  ...[false, true].map((compressed) => ({
    name: `iTXt ${compressed ? "compressed" : "uncompressed"}`,
    type: "iTXt",
    data: (text) =>
      Buffer.concat([
        Buffer.from(`Comment\0${compressed ? "\x01" : "\x00"}\0en\0Comment\0`, "latin1"),
        compressed ? deflateSync(Buffer.from(text, "utf8")) : Buffer.from(text, "utf8"),
      ]),
  })),
]) {
  test(`the scan finds registered metadata in a checked PNG with ${name}`, () => {
    const P = privateWithAccount();
    const E = fresh("evidence");
    for (const [file, text] of [
      ["metadata.png", `note ${PASSWORD}`],
      ["clean.png", "ordinary note"],
    ]) {
      const png = metadataPng(type, data(text));
      writeFileSync(join(E, file), png);
      writeFileSync(
        join(E, `${file}.checked`),
        JSON.stringify({ sha256: createHash("sha256").update(png).digest("hex") }),
      );
    }
    const run = node([join(here, "scan-evidence.mjs"), "--dir", E, "--secrets", P]);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /metadata\.png · a value from account\.json/);
    assert.deepEqual(JSON.parse(readFileSync(join(E, "scan.json"), "utf8")).hits, [
      { file: "metadata.png", kind: "a value from account.json" },
    ]);
    assert.ok(
      !`${run.stdout}${run.stderr}${readFileSync(join(E, "scan.json"), "utf8")}`.includes(PASSWORD),
    );
  });
}

test("the scan refuses archives, and knows a lone pairing code and a private key", () => {
  const P = privateWithAccount();
  const E = fresh("evidence");
  writeFileSync(
    join(E, "trace.zip"),
    Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(16)]),
  );
  writeFileSync(join(E, "pairing.aria.yml"), "  - paragraph: code\n  - paragraph: K7QZ-3MXP\n");
  writeFileSync(
    join(E, "key.txt"),
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIPlanted\n-----END PRIVATE KEY-----\n",
  );
  const run = node([join(here, "scan-evidence.mjs"), "--dir", E, "--secrets", P]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /trace\.zip · an archive, which cannot be searched/);
  assert.match(run.stdout, /pairing\.aria\.yml · 1 × pairing code/);
  assert.match(run.stdout, /key\.txt · 1 × private key/);
});

// Sol round 3's fixtures (registry-cases): a name used twice, a value too short to redact, and a
// truncated browser state that holds a registered value.
const EARLIER = "earlier-q7Nb9Za4Pk2Mw8Ve";

const LATER = "later-v3Qz8Gm5Dx1Bn6Hr";

const COOKIE = "review-cookie-q8Lp2Nr7Zx3Ks9Bv";

test("a name used twice keeps both values: redacted, and found by the scan", () => {
  const P = fresh("private");
  register(P, "x", EARLIER);
  register(P, "x", LATER);
  const secrets = loadSecrets(P);
  assert.equal(redactValues(`${EARLIER} ${LATER}`, secrets), "<secret> <secret>");
  const E = fresh("evidence");
  writeFileSync(join(E, "planted.txt"), `the earlier value ${EARLIER}`);
  const scan = node([join(here, "scan-evidence.mjs"), "--dir", E, "--secrets", P]);
  assert.equal(scan.status, 1, "the scan missed the earlier value");
  assert.ok(!`${scan.stdout}${scan.stderr}`.includes(EARLIER), "the scan printed the value");
});

test("a rewritten state file keeps the values it held", () => {
  const P = fresh("private");
  writeFileSync(
    join(P, "browser.json"),
    JSON.stringify({ cookies: [{ name: "s", value: COOKIE }] }),
  );
  loadSecrets(P);
  writeFileSync(
    join(P, "browser.json"),
    JSON.stringify({ cookies: [{ name: "s", value: LATER }] }),
  );
  const secrets = loadSecrets(P);
  assert.ok(secrets.has(COOKIE), "the earlier cookie left the registry");
  assert.ok(secrets.has(LATER));
});

test("a value too short to redact is refused, loudly and without the value", () => {
  const P = fresh("private");
  assert.throws(
    () => register(P, "short-code", "Q7XZ"),
    (error) => /refused: under 6 characters/.test(error.message) && !error.message.includes("Q7XZ"),
  );
  assert.ok(!existsSync(join(P, "secrets")) || readdirSync(join(P, "secrets")).length === 0);
});

test("a secret file's common lines stay readable; its credential lines do not", () => {
  const P = fresh("private");
  register(P, "secret-file", SECRET_FILE);
  const secrets = loadSecrets(P);
  const text = "the [default] profile, AKIAQ7XWZ3K9P2M4N6B8 and q8Rt5Lm2Np7Xv4Zw9Ab3Cd6Ef1Gh8Jk0";
  assert.equal(redactValues(text, secrets), "the [default] profile, <secret> and <secret>");
  assert.ok(!redactValues(SECRET_FILE, secrets).includes("q8Rt5Lm2"));
});

test("malformed browser state fails with a fixed message and none of its values", () => {
  const P = fresh("private");
  writeFileSync(join(P, "account.json"), JSON.stringify({ password: COOKIE }), { mode: 0o600 });
  writeFileSync(join(P, "browser.json"), `{"cookies":[{"value":"${COOKIE}",`, { mode: 0o600 });
  const out = fresh("evidence");
  const run = drive(P, out, "export default async () => {};", ["--state", join(P, "browser.json")]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /the browser state file is not valid JSON; nothing of it shown/);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(COOKIE), "the cookie reached the terminal");
  assert.ok(!everything(out).includes(COOKIE), "the cookie reached the evidence");
});

test(
  "the driver keeps a rotated value redacted and fails on a short one",
  { skip: noBrowser },
  () => {
    const P = privateWithAccount();
    const out = fresh("evidence");
    const run = drive(
      P,
      out,
      `export default async ({ page, capture, note, registerSecret, typeSecret }) => {
        registerSecret("rotated", ${JSON.stringify(EARLIER)});
        registerSecret("rotated", ${JSON.stringify(LATER)});
        await page.setContent("<p>${EARLIER}</p>");
        await capture("rotated");
        note("old credential ${EARLIER}");
        await page.setContent("<label>Account PIN<input></label>");
        await typeSecret(page.getByLabel("Account PIN"), "pin", "5832");
      };`,
    );
    assert.equal(run.status, 1, "a short typed value was accepted");
    assert.match(run.stderr, /secret "pin" refused: under 6 characters/);
    assert.ok(!run.stderr.includes("5832"));
    const evidence = everything(out);
    assert.ok(!evidence.includes(EARLIER), "the earlier value reached the evidence");
    assert.ok(!evidence.includes("5832"), "the short value reached the evidence");
    assert.ok(
      existsSync(join(out, "rotated.png.withheld")),
      "the earlier value's screenshot was kept",
    );
    const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", P]);
    assert.equal(scan.status, 0, scan.stdout);
  },
);

// Sol round 4's retention-paths: the private directory spelled with a trailing slash, or relative.
const PATH_EARLIER = "path-earlier-k7Mx8Qw3Lt6Nv2Za";

const PATH_LATER = "path-later-q4Zv8Ne2Lk9Wa6Pm";

const SPELLINGS = [
  ["a trailing slash", (base) => ({ arg: `${join(base, "private")}/`, cwd: base })],
  ["a relative ./private", (base) => ({ arg: "./private", cwd: base })],
];

const cookieState = (value) =>
  JSON.stringify({
    cookies: [
      {
        name: "auth",
        value,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  });

test("a private directory that cannot be resolved is refused", () => {
  const missing = join(fresh("gone"), "private");
  assert.throws(() => loadSecrets(missing), /cannot be resolved/);
  assert.throws(() => register(missing, "x", PASSWORD), /cannot be resolved/);
  const P = fresh("private");
  assert.equal(privateRoot(`${P}/`), privateRoot(P));
});

for (const [spelling, spell] of SPELLINGS) {
  test(`a rewritten state file keeps its values with ${spelling}`, () => {
    const base = fresh("paths");
    mkdirSync(join(base, "private"), { mode: 0o700 });
    const { arg, cwd } = spell(base);
    const state = join(base, "private", "browser.json");
    // Two separate processes, as two drives are, each loading the registry from that spelling.
    const load = (value) => {
      writeFileSync(state, cookieState(value), { mode: 0o600 });
      const run = node(
        [
          "--input-type=module",
          "-e",
          `import { loadSecrets } from ${JSON.stringify(join(here, "secrets.mjs"))};
          process.stdout.write(String(loadSecrets(${JSON.stringify(arg)}).has(${JSON.stringify(PATH_EARLIER)})));`,
        ],
        { cwd },
      );
      assert.equal(run.status, 0, run.stderr);
      return run.stdout;
    };
    load(PATH_EARLIER);
    assert.equal(load(PATH_LATER), "true", "the earlier cookie left the registry");
  });

  test(
    `a rotated browser cookie stays out of the evidence with ${spelling}`,
    { skip: noBrowser },
    () => {
      const base = fresh("paths");
      mkdirSync(join(base, "private"), { mode: 0o700 });
      const { arg, cwd } = spell(base);
      const state = join(base, "private", "browser.json");
      writeFileSync(state, cookieState(PATH_EARLIER), { mode: 0o600 });
      tunnelTo(join(base, "private"), 9);
      const run = (out, recipe) => {
        const recipePath = join(base, `${out}.mjs`);
        writeFileSync(recipePath, recipe);
        return node(
          [
            join(here, "drive-web.mjs"),
            "--web",
            "http://127.0.0.1:9",
            "--private",
            arg,
            "--state",
            state,
            "--out",
            join(base, out),
            "--recipe",
            recipePath,
            "--timeout",
            "1500",
          ],
          { cwd },
        );
      };
      // The first drive rotates the cookie, and its finalization saves the new state.
      const first = run(
        "first",
        `export default async ({ page }) => {
          const cookies = await page.context().cookies();
          await page.context().addCookies(cookies.map((cookie) => ({ ...cookie, value: ${JSON.stringify(PATH_LATER)} })));
        };`,
      );
      assert.equal(first.status, 0, first.stderr);
      assert.ok(readFileSync(state, "utf8").includes(PATH_LATER), "the state was not rewritten");
      // The second shows the earlier value.
      const second = run(
        "second",
        `export default async ({ page, capture, note }) => {
          await page.setContent("<p>${PATH_EARLIER}</p>");
          await capture("earlier");
          note("old credential ${PATH_EARLIER}");
        };`,
      );
      assert.equal(second.status, 0, second.stderr);
      const out = join(base, "second");
      assert.ok(!everything(out).includes(PATH_EARLIER), "the earlier cookie reached the evidence");
      assert.ok(existsSync(join(out, "earlier.png.withheld")), "its screenshot was kept");
      writeFileSync(join(out, "planted.txt"), PATH_EARLIER);
      const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", arg], { cwd });
      assert.equal(scan.status, 1, "the scan missed a planted earlier cookie");
    },
  );
}

// Review of #662, F4: a terminal draws its output on a canvas, beside an empty input, aria-hidden.
const terminalPage = (shown) =>
  `<main><textarea aria-label="Terminal input"></textarea><canvas aria-hidden="true" width="600" height="80"></canvas></main>
   <script>const c = document.querySelector("canvas").getContext("2d"); c.font = "24px monospace"; c.fillText(${JSON.stringify(shown)}, 10, 40);</script>`;

test(
  "a terminal canvas with secret or ordinary pixels keeps only its redacted snapshot",
  { skip: noBrowser },
  () => {
    const privateDir = privateWithAccount();
    const snapshots = [];
    for (const shown of [TOKEN, "nothing to see here"]) {
      const out = fresh("evidence");
      const run = drive(
        privateDir,
        out,
        `export default async ({ page, capture }) => {
          await page.setContent(${JSON.stringify(terminalPage(shown))});
          await capture("terminal");
        };`,
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(existsSync(join(out, "terminal.png")), false);
      assert.equal(existsSync(join(out, "terminal.png.checked")), false);
      assert.match(
        readFileSync(join(out, "steps.log"), "utf8"),
        /opaque content requiring screenshot masking/,
      );
      const scan = node([join(here, "scan-evidence.mjs"), "--dir", out, "--secrets", privateDir]);
      assert.equal(scan.status, 0, scan.stdout);
      snapshots.push(readFileSync(join(out, "terminal.aria.yml"), "utf8"));
      assert.ok(!everything(out).includes(TOKEN));
    }
    assert.equal(snapshots[0], snapshots[1], "opaque canvas content entered the snapshot");
  },
);

test("text a page hides from screen readers is checked too", { skip: noBrowser }, () => {
  const privateDir = privateWithAccount();
  const out = fresh("evidence");
  const run = drive(
    privateDir,
    out,
    `export default async ({ page, capture }) => {
      await page.setContent('<main><div aria-hidden="true">${TOKEN}</div><p>visible</p></main>');
      await capture("hidden");
    };`,
  );
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(out, "hidden.png.withheld")), "the screenshot was kept");
  assert.ok(!everything(out).includes(TOKEN));
});

test("the scan refuses an image no driver vouched for, or one changed since", () => {
  const P = privateWithAccount();
  const E = fresh("evidence");
  // A PNG with no text chunk: only pixels, which the scan cannot read.
  const png = Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    chunk("IHDR", Buffer.alloc(13)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(join(E, "recipe-shot.png"), png);
  writeFileSync(join(E, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
  writeFileSync(join(E, "vouched.png"), png);
  const sha256 = createHash("sha256").update(png).digest("hex");
  writeFileSync(join(E, "vouched.png.checked"), JSON.stringify({ sha256 }));
  writeFileSync(join(E, "changed.png"), Buffer.concat([png, Buffer.from("x")]));
  writeFileSync(join(E, "changed.png.checked"), JSON.stringify({ sha256 }));
  const run = node([join(here, "scan-evidence.mjs"), "--dir", E, "--secrets", P, "--delete-hits"]);
  assert.equal(run.status, 1);
  for (const file of ["recipe-shot.png", "photo.jpg", "changed.png"]) {
    assert.match(
      run.stdout,
      new RegExp(`${file.replace(".", "\\.")} · an image no driver checked`),
    );
    assert.ok(!existsSync(join(E, file)), `${file} was kept`);
  }
  assert.doesNotMatch(run.stdout, /vouched\.png ·/);
  assert.ok(existsSync(join(E, "vouched.png")));
});

// Review of #662, F5: `mend login` prints its authorization code and the link that carries it.
const CODE = "K7QZ-3MXP";

const LOGIN_OUTPUT = `✓ authorize request open at http://localhost:3325
  code    ${CODE} · approve only if the browser shows the same code
  browser http://localhost:3325/authorize?code=${CODE}
`;

test("an authorization code a terminal prints joins the registry by value, and leaves no capture", () => {
  const P = privateWithAccount();
  const E = fresh("evidence");
  const run = spawnSync(
    "sh",
    [join(here, "capture.sh"), E, "login", "--", "printf", "%s", LOGIN_OUTPUT],
    {
      encoding: "utf8",
      env: { ...process.env, MEND_VERIFY_PRIVATE: P },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!everything(E).includes(CODE), "the code reached the capture");
  assert.match(
    readFileSync(join(E, "login.stdout"), "utf8"),
    /code {4}<(?:secret|authorization code)>/,
  );
  const secrets = loadSecrets(P);
  assert.ok(secrets.has(CODE) && secrets.has(CODE.replace("-", "")), "the code is not registered");
  // Registered, it is found wherever it turns up next, ungrouped included.
  writeFileSync(join(E, "later.txt"), `typed ${CODE.replace("-", "")} into the browser`);
  const scan = node([join(here, "scan-evidence.mjs"), "--dir", E, "--secrets", P]);
  assert.equal(scan.status, 1);
  assert.match(scan.stdout, /later\.txt · a value from secrets\/minted-code/);
});

const noTmux = spawnSync("tmux", ["-V"]).status === 0 ? false : "tmux is not installed";

test(
  "the terminal driver registers the code it shows before keeping a capture",
  { skip: noTmux },
  () => {
    const P = privateWithAccount();
    const home = fresh("tui");
    tunnelTo(P, 3325);
    const bundle = join(home, "mend-verify", "tui-cli-bundle");
    mkdirSync(join(bundle, "real"), { recursive: true });
    writeFileSync(join(bundle, "real", "mend"), "#!/bin/sh\n");
    chmodSync(join(bundle, "real", "mend"), 0o755);
    const env = { ...process.env, MEND_VERIFY_PRIVATE: P, XDG_CACHE_HOME: home, TMUX_TMPDIR: home };
    const tui = (...args) =>
      spawnSync("sh", [join(here, "drive-tui.sh"), ...args], { encoding: "utf8", env });
    try {
      assert.equal(
        tui("start", "login", "http://localhost:3325", "--", "printf", "%s", LOGIN_OUTPUT).status,
        0,
      );
      assert.equal(tui("wait", "login", "command ended", "10").status, 0);
      const E = fresh("evidence");
      assert.equal(tui("capture", "login", E, "login").status, 0);
      assert.ok(!everything(E).includes(CODE), "the code reached the capture");
      assert.ok(loadSecrets(P).has(CODE), "the code is not registered");
    } finally {
      spawnSync("tmux", ["-L", "st-verify-tui", "kill-server"], { env });
    }
  },
);
