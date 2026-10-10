#!/usr/bin/env node
// The verify skill's leak check: no secret this run held or typed, and no credential shape, in the
// evidence.
//
//   node .claude/skills/verify/scripts/scan-evidence.mjs --dir <evidence dir> --secrets <private dir> \
//     [--delete-hits]
//
// The secrets are the run's whole registry (secrets.mjs): the handed-over account, the browser's
// cookies, the handover key, everything a recipe typed or a page minted, line by line and encoded,
// plus `MEND_VERIFY_SCAN_EXTRA` (a colon-separated list of further JSON or secret files, such as the
// outer CLI's config). Every file under --dir is searched for each value and for each shape
// redact.mjs knows: as text, as raw bytes, and for a PNG, every text chunk (tEXt, and zTXt and iTXt
// inflated). An archive (zip, a Playwright trace, a HAR) cannot be searched here and counts as a
// hit: the driver never records one. So does an image (PNG, JPEG, GIF, WebP, BMP, TIFF, by its bytes
// or its name): its pixels cannot be searched, so one counts as a hit unless drive-web.mjs vouched
// for it, with a <image>.checked beside it whose sha256 is the image's own (written after the page's
// text was checked and every canvas, video, object and unreadable frame was masked). An image a
// recipe or another tool saved, or one changed since, has no such file. A hit names the file and the
// kind, never the value.
//
// It writes <dir>/scan.json (files, secret count, hits by file and kind; no value) whatever the
// result. Exit 0: no hit. Exit 1: hits; with --delete-hits, every file that had one is deleted
// first (scan.json says which). Exit 2: nothing to compare (the registry is empty).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { CREDENTIAL_PATTERNS } from "./redact.mjs";
import { loadSecrets } from "./secrets.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const dir = flag("dir");
const secretsDir = flag("secrets");
const deleteHits = args.includes("--delete-hits");
if (!dir || !secretsDir) {
  process.stderr.write(
    "usage: scan-evidence.mjs --dir <evidence dir> --secrets <private dir> [--delete-hits]\n",
  );
  process.exit(2);
}

const files = (root) =>
  readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

const extra = (process.env.MEND_VERIFY_SCAN_EXTRA ?? "").split(":").filter(Boolean);
const secrets = loadSecrets(secretsDir, extra);
if (secrets.size === 0) {
  process.stdout.write(`scan · no secret registered in ${secretsDir}: nothing compared\n`);
  process.exit(2);
}

/** Every text chunk of a PNG, inflated where it is compressed. */
const pngText = (bytes) => {
  const texts = [];
  if (bytes.subarray(0, 8).toString("latin1") !== "\x89PNG\r\n\x1a\n") return texts;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    const data = bytes.subarray(at + 8, at + 8 + length);
    try {
      if (type === "tEXt") texts.push(data.toString("latin1"));
      else if (type === "zTXt") {
        const keyEnd = data.indexOf(0);
        texts.push(inflateSync(data.subarray(keyEnd + 2)).toString("latin1"));
      } else if (type === "iTXt") {
        const keyEnd = data.indexOf(0);
        const compressed = data[keyEnd + 1] === 1;
        // Keyword, NUL, compression flag, method, language tag NUL, translated keyword NUL, text.
        let rest = keyEnd + 3;
        rest = data.indexOf(0, rest) + 1;
        rest = data.indexOf(0, rest) + 1;
        const body = data.subarray(rest);
        texts.push((compressed ? inflateSync(body) : body).toString("utf8"));
      }
    } catch {
      texts.push("<an unreadable text chunk>");
    }
    at += 12 + length;
  }
  return texts;
};

const ARCHIVE = /\.(?:zip|trace|har|tar|gz|tgz|7z)$/i;
const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|heic)$/i;
const IMAGE_MAGIC = [
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
  [0x42, 0x4d],
  [0x49, 0x49, 0x2a, 0x00],
  [0x4d, 0x4d, 0x00, 0x2a],
];
const isImage = (path, bytes) =>
  IMAGE.test(path) ||
  IMAGE_MAGIC.some((magic) => magic.every((byte, at) => bytes[at] === byte)) ||
  (bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP");

/** drive-web.mjs's word for an image: its .checked file names this image's digest. */
const vouched = (path, bytes) => {
  if (!existsSync(`${path}.checked`)) return false;
  try {
    const { sha256 } = JSON.parse(readFileSync(`${path}.checked`, "utf8"));
    return sha256 === createHash("sha256").update(bytes).digest("hex");
  } catch {
    return false;
  }
};
const evidence = files(dir).filter((path) => path !== join(dir, "scan.json"));
const hits = [];
for (const path of evidence) {
  const name = path.slice(dir.length + 1);
  const bytes = readFileSync(path);
  if (ARCHIVE.test(path) || bytes.subarray(0, 4).toString("latin1") === "PK\x03\x04") {
    hits.push({ file: name, kind: "an archive, which cannot be searched" });
    continue;
  }
  if (isImage(path, bytes) && !vouched(path, bytes))
    hits.push({ file: name, kind: "an image no driver checked, whose pixels cannot be searched" });
  const views = [bytes.toString("utf8"), bytes.toString("latin1"), ...pngText(bytes)];
  const sources = new Set();
  for (const [value, source] of secrets)
    if (views.some((view) => view.includes(value))) sources.add(source);
  for (const source of sources) hits.push({ file: name, kind: `a value from ${source}` });
  for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
    // A redacted shape (`/join/<token>`, `mdt_<token>`) is the redaction itself.
    const found = [
      ...new Set(
        views
          .flatMap((view) => view.match(new RegExp(pattern.source, pattern.flags)) ?? [])
          .filter((match) => !match.includes("<")),
      ),
    ];
    if (found.length > 0) hits.push({ file: name, kind: `${found.length} × ${kind}` });
  }
}

const hitFiles = [...new Set(hits.map((hit) => hit.file))];
if (deleteHits) for (const file of hitFiles) rmSync(join(dir, file), { force: true });
writeFileSync(
  join(dir, "scan.json"),
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      files: evidence.length,
      secretValues: secrets.size,
      shapes: CREDENTIAL_PATTERNS.length,
      hits,
      deleted: deleteHits ? hitFiles : [],
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `scan · ${evidence.length} file(s) under ${dir} · ${secrets.size} secret value(s) and ${CREDENTIAL_PATTERNS.length} credential shapes · ${hits.length} hit(s)${deleteHits && hitFiles.length > 0 ? ` · ${hitFiles.length} file(s) deleted` : ""}\n`,
);
for (const hit of hits) process.stdout.write(`  ${hit.file} · ${hit.kind}\n`);
process.exit(hits.length === 0 ? 0 : 1);
