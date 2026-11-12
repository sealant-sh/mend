// The fixtures, secrets and drivers the verify skill's leak tests share (leaks*.test.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

import { identityOf } from "./guard/policy.mjs";

export const here = fileURLToPath(new URL(".", import.meta.url));

// Every driver reaches only the declared outer and the run's tunnel (guard/policy.mjs): the
// fixtures record their port as the tunnel's, beside this declared outer.
process.env.MEND_VERIFY_OUTER_URL = "http://127.0.0.1:23105";

export const tunnelTo = (privateDir, port) =>
  writeFileSync(
    join(privateDir, "tunnel.json"),
    JSON.stringify({
      port: String(port),
      pid: process.pid,
      identity: identityOf(process.pid),
      bound: true,
    }),
  );

export const skillMd = readFileSync(join(here, "..", "SKILL.md"), "utf8");

export const playwright =
  process.env.MEND_VERIFY_PLAYWRIGHT ?? join(homedir(), ".cache", "mend-verify", "playwright");

export const noBrowser = existsSync(join(playwright, "node_modules", "playwright-core"))
  ? false
  : "Playwright is not installed for the skill (~/.cache/mend-verify/playwright)";

export const PASSWORD = "pw-3f9c1e7a2b8d4c60a1e5";

export const TOKEN = "tok-8b1d2e3f4a5c6b7d8e9f";

export const SETUP_TOKEN = "sk-ant-oat01-Zq8Xv2Lm4Np6Rt8Wy0Ab2Cd4Ef6";

export const SECRET_FILE =
  "[default]\naws_access_key_id = AKIAQ7XWZ3K9P2M4N6B8\naws_secret_access_key = q8Rt5Lm2Np7Xv4Zw9Ab3Cd6Ef1Gh8Jk0";

/** A PNG chunk with a zero CRC: the scan reads chunks, it does not check them. */
export const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};

/** A valid one-pixel PNG, including a metadata chunk with its actual CRC. */
export const metadataPng = (type, data) => {
  const checkedChunk = (chunkType, chunkData) => {
    const bytes = chunk(chunkType, chunkData);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    checkedChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    checkedChunk(type, data),
    checkedChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    checkedChunk("IEND", Buffer.alloc(0)),
  ]);
};

export const scratchRoots = [];

export const fresh = (name) => {
  const root = mkdtempSync(join(tmpdir(), `verify-leaks-${name}-`));
  scratchRoots.push(root);
  return root;
};

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** Every file under a directory, as one string of its raw bytes. */
export const everything = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"))
    .join("\n");

export const privateWithAccount = () => {
  const dir = fresh("private");
  writeFileSync(
    join(dir, "account.json"),
    JSON.stringify({ email: "verifier@verify-stack.invalid", password: PASSWORD, token: TOKEN }),
    { mode: 0o600 },
  );
  return dir;
};

export const node = (args, options = {}) =>
  spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120_000, ...options });

export const drive = (privateDir, out, recipe, extra = []) => {
  const recipePath = join(fresh("recipe"), "recipe.mjs");
  writeFileSync(recipePath, recipe);
  tunnelTo(privateDir, 9);
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

export const closedContent = (kind, shown, nested = false) => `
  let host = document.getElementById("host");
  if (${nested}) {
    const open = host.attachShadow({ mode: "open" });
    host = document.createElement("div"); open.appendChild(host);
  }
  const root = host.attachShadow({ mode: "closed" });
  const content = document.createElement(${JSON.stringify(kind === "canvas" ? "canvas" : "p")});
  if (${kind === "canvas"}) {
    content.width = 800; content.height = 100;
    const context = content.getContext("2d"); context.font = "24px monospace";
    context.fillText(${JSON.stringify(shown)}, 10, 40);
  } else content.textContent = ${JSON.stringify(shown)};
  root.appendChild(content);
`;
