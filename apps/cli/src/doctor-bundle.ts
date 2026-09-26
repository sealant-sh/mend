import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

import { usageOf } from "./help.ts";

/**
 * `mend doctor --bundle`: everything a maintainer asks for one output at a time, collected once
 * into a tar.gz of text and JSON files. Each collector writes its own files and fails on its own:
 * a collector that throws leaves `<name>.error.txt` with the failure, and the bundle still lands.
 * One redactor runs over every file before it is written, so a token that reaches a log line is
 * blanked whether the line came from Docker, the API, or this process's own environment.
 */

// ── redaction ─────────────────────────────────────────────────────────────

const REDACTED = "[redacted]";

const KEY_WORDS = "password|passwd|secret|token|api[_-]?key|private[_-]?key|credential";

/**
 * Ordered: header values first, then tokens by shape, then credentials in URLs, then any
 * `key=value` / `"key": "value"` whose key names a secret, then every dotenv-shaped line.
 * Over-eager on purpose: a blanked `tokenSuffix` costs nothing, a leaked token does.
 */
type Replacer = (match: string, ...groups: Array<string>) => string;

const blank: Replacer = () => REDACTED;

const RULES: ReadonlyArray<readonly [RegExp, Replacer]> = [
  [
    /\b(authorization|proxy-authorization|x-api-key|cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+/gi,
    (_match, header: string, separator: string) => `${header}${separator}${REDACTED}`,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, () => `Bearer ${REDACTED}`],
  [/\b(?:xox[abops]|xapp)-[A-Za-z0-9-]+/g, blank],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, blank],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}/g, blank],
  [/\bgithub_pat_[A-Za-z0-9_]{6,}/g, blank],
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/g, blank],
  [/\bAKIA[0-9A-Z]{16}\b/g, blank],
  [
    /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi,
    (_match, prefix: string) => `${prefix}:${REDACTED}@`,
  ],
  [
    new RegExp(
      `\\b([A-Za-z0-9_.-]*(?:${KEY_WORDS})[A-Za-z0-9_.-]*)("?\\s*[=:]\\s*"?)([^"\\s,;&]+)`,
      "gi",
    ),
    (_match, key: string, separator: string, value: string) =>
      /^(?:true|false|null)$/i.test(value)
        ? `${key}${separator}${value}`
        : `${key}${separator}${REDACTED}`,
  ],
  [/^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*=)(.+)$/gm, (_match, key: string) => `${key}${REDACTED}`],
];

/** The one redactor every bundle file passes through. */
export const redact = (text: string): string => {
  let out = text;
  for (const [pattern, replacer] of RULES) out = out.replace(pattern, replacer);
  return out;
};

// ── tar ───────────────────────────────────────────────────────────────────

export interface TarEntry {
  readonly path: string;
  readonly content: Buffer;
}

const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, "0")}\0`;

const splitName = (name: string): { readonly name: string; readonly prefix: string } => {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  let cut = name.lastIndexOf("/");
  while (cut > 0 && Buffer.byteLength(name.slice(cut + 1)) > 100)
    cut = name.lastIndexOf("/", cut - 1);
  if (cut <= 0 || Buffer.byteLength(name.slice(0, cut)) > 155)
    throw new Error(`tar entry name too long: ${name}`);
  return { name: name.slice(cut + 1), prefix: name.slice(0, cut) };
};

const tarHeader = (entry: TarEntry, mtime: number): Buffer => {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitName(entry.path);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(entry.content.length, 12), 124, 12, "ascii");
  header.write(octal(mtime, 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("mend", 265, 32, "ascii");
  header.write("mend", 297, 32, "ascii");
  header.write(octal(0, 8), 329, 8, "ascii");
  header.write(octal(0, 8), 337, 8, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
};

/** A ustar archive, gzipped. Plain files only: extractors create the directories. */
export const tarGz = (entries: ReadonlyArray<TarEntry>, now: Date): Buffer => {
  const mtime = Math.floor(now.getTime() / 1000);
  const blocks: Array<Buffer> = [];
  for (const entry of entries) {
    blocks.push(tarHeader(entry, mtime), entry.content);
    const remainder = entry.content.length % 512;
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
};

// ── collecting ────────────────────────────────────────────────────────────

export interface BundleFile {
  /** Relative to the bundle's root directory, e.g. `server-logs/mend.log`. */
  readonly path: string;
  readonly content: string;
}

export interface Collector {
  /** The file `<name>.error.txt` when the collector throws. */
  readonly name: string;
  readonly collect: () => Promise<ReadonlyArray<BundleFile>>;
}

export const describeError = (error: unknown): string =>
  `${error instanceof Error ? error.message : String(error)}\n`;

/** Every collector in order, each on its own; every file redacted before it is kept. */
export const collectBundle = async (
  collectors: ReadonlyArray<Collector>,
): Promise<ReadonlyArray<BundleFile>> => {
  const files: Array<BundleFile> = [];
  for (const collector of collectors) {
    try {
      for (const file of await collector.collect()) {
        files.push({ path: file.path, content: redact(file.content) });
      }
    } catch (error) {
      files.push({ path: `${collector.name}.error.txt`, content: redact(describeError(error)) });
    }
  }
  return files;
};

// ── writing ───────────────────────────────────────────────────────────────

/** `mend-bundle-2026-09-26T10-15-30Z.tgz`: sortable, no characters a shell minds. */
export const bundleFileName = (now: Date): string =>
  `mend-bundle-${now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-")}.tgz`;

export interface WrittenEntry {
  readonly path: string;
  readonly bytes: number;
}

export interface WrittenBundle {
  readonly path: string;
  readonly bytes: number;
  readonly entries: ReadonlyArray<WrittenEntry>;
}

/** The archive at `outPath` (its directory created 0700 when missing, the file 0600). */
export const writeBundle = (
  files: ReadonlyArray<BundleFile>,
  outPath: string,
  now: Date,
): WrittenBundle => {
  const directory = path.dirname(outPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = path.basename(outPath).replace(/\.(?:tgz|tar\.gz)$/, "");
  const entries = files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.content, "utf8"),
  }));
  const bytes = tarGz(
    entries.map((entry) => ({ path: `${root}/${entry.path}`, content: entry.content })),
    now,
  );
  fs.writeFileSync(outPath, bytes, { mode: 0o600 });
  fs.chmodSync(outPath, 0o600);
  return {
    path: outPath,
    bytes: bytes.length,
    entries: entries.map((entry) => ({ path: entry.path, bytes: entry.content.length })),
  };
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const NOTICE =
  "Contains logs and configuration; secrets are redacted, but read it before sharing.";

/** What the command prints: the path, one line per file with its size, the notice. */
export const bundleReport = (written: WrittenBundle): ReadonlyArray<string> => {
  const width = Math.max(...written.entries.map((entry) => entry.path.length), 0);
  return [
    `${written.path} · ${formatBytes(written.bytes)}`,
    ...written.entries.map((entry) => `  ${entry.path.padEnd(width)}  ${formatBytes(entry.bytes)}`),
    NOTICE,
  ];
};

// ── the command ───────────────────────────────────────────────────────────

export const DEFAULT_TAIL = 500;
export const MAX_TAIL = 2000;

export interface BundleArgs {
  readonly out: string | null;
  readonly tail: number;
}

export type ParsedBundleArgs =
  | { readonly kind: "ok"; readonly args: BundleArgs }
  | { readonly kind: "usage"; readonly message: string };

const usage = (message: string): ParsedBundleArgs => ({
  kind: "usage",
  message: `${message}\n${usageOf("doctor")}`,
});

/** `--bundle [--out <path>] [--tail <n>]`; anything else is the usage line. */
export const parseBundleArgs = (args: ReadonlyArray<string>): ParsedBundleArgs => {
  let out: string | null = null;
  let tail = DEFAULT_TAIL;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--bundle") continue;
    if (arg === "--out") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return usage("--out needs a path");
      out = value;
      index += 1;
      continue;
    }
    if (arg === "--tail") {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) return usage("--tail needs a number");
      tail = Number(value);
      if (tail < 1 || tail > MAX_TAIL) return usage(`--tail is 1..${MAX_TAIL}`);
      index += 1;
      continue;
    }
    return usage(`unknown option "${arg ?? ""}"`);
  }
  return { kind: "ok", args: { out, tail } };
};

export interface BundleCommandDeps {
  /** Where the archive lands without --out: `~/.config/mend/bundles`. */
  readonly defaultDir: string;
  readonly collectors: (tail: number) => ReadonlyArray<Collector>;
  readonly now: () => Date;
  readonly say: (line: string) => void;
  readonly warn: (line: string) => void;
}

/** Collects, writes, reports. A usage error sets the exit code; nothing else fails the command. */
export const doctorBundleCommand = async (
  args: ReadonlyArray<string>,
  deps: BundleCommandDeps,
): Promise<void> => {
  const parsed = parseBundleArgs(args);
  if (parsed.kind === "usage") {
    deps.warn(`mend: ${parsed.message}`);
    process.exitCode = 1;
    return;
  }
  const now = deps.now();
  const outPath = path.resolve(parsed.args.out ?? path.join(deps.defaultDir, bundleFileName(now)));
  deps.warn("collecting · this can take a minute");
  const files = await collectBundle(deps.collectors(parsed.args.tail));
  const written = writeBundle(files, outPath, now);
  for (const line of bundleReport(written)) deps.say(line);
};
