// The verify skill's leak paths, each forced with a synthetic secret. The browser cases need the
// skill's Playwright (~/.cache/mend-verify/playwright, or $MEND_VERIFY_PLAYWRIGHT) and are skipped,
// with that reason, where it is not installed; the rest need only Node.
//
//   node --test .claude/skills/verify/scripts/leaks.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { loadSecrets, privateRoot, redactValues, register } from "./secrets.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const skillMd = readFileSync(join(here, "..", "SKILL.md"), "utf8");
const playwright =
  process.env.MEND_VERIFY_PLAYWRIGHT ?? join(homedir(), ".cache", "mend-verify", "playwright");
const noBrowser = existsSync(join(playwright, "node_modules", "playwright-core"))
  ? false
  : "Playwright is not installed for the skill (~/.cache/mend-verify/playwright)";

const PASSWORD = "pw-3f9c1e7a2b8d4c60a1e5";
const TOKEN = "tok-8b1d2e3f4a5c6b7d8e9f";
const SETUP_TOKEN = "sk-ant-oat01-Zq8Xv2Lm4Np6Rt8Wy0Ab2Cd4Ef6";
const SECRET_FILE =
  "[default]\naws_access_key_id = AKIAQ7XWZ3K9P2M4N6B8\naws_secret_access_key = q8Rt5Lm2Np7Xv4Zw9Ab3Cd6Ef1Gh8Jk0";

/** A PNG chunk with a zero CRC: the scan reads chunks, it does not check them. */
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};

const fresh = (name) => mkdtempSync(join(tmpdir(), `verify-leaks-${name}-`));
/** Every file under a directory, as one string of its raw bytes. */
const everything = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"))
    .join("\n");
const privateWithAccount = () => {
  const dir = fresh("private");
  writeFileSync(
    join(dir, "account.json"),
    JSON.stringify({ email: "verifier@verify-stack.invalid", password: PASSWORD, token: TOKEN }),
    { mode: 0o600 },
  );
  return dir;
};
const node = (args, options = {}) =>
  spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120_000, ...options });

const drive = (privateDir, out, recipe, extra = []) => {
  const recipePath = join(fresh("recipe"), "recipe.mjs");
  writeFileSync(recipePath, recipe);
  return node([
    join(here, "drive-web.mjs"),
    "--web",
    "http://127.0.0.1:9",
    "--out",
    out,
    "--recipe",
    recipePath,
    "--private",
    privateDir,
    "--timeout",
    "1500",
    ...extra,
  ]);
};

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
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        '<label>Email <input name="email"></label><label>Password <input type="password" disabled></label><button>Sign in</button>',
      );
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const web = `http://127.0.0.1:${server.address().port}`;
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
    }).finally(() => server.close());
    assert.equal(run.status, 1);
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

test("the scan reads PNG text chunks, refuses archives, and knows a lone pairing code and a private key", () => {
  const P = privateWithAccount();
  const E = fresh("evidence");
  const png = Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    chunk(
      "zTXt",
      Buffer.concat([Buffer.from("Comment\0\0", "latin1"), deflateSync(`note ${PASSWORD}`)]),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(join(E, "metadata.png"), png);
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
  assert.match(run.stdout, /metadata\.png · a value from account\.json/);
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
