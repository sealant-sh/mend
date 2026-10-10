// The verify skill's secret registry: every secret value this run holds or types, in one place, so
// every output path can redact it by value and the evidence scan can search for it by value.
// Shapes (redact.mjs) catch what Mend prints; values catch what a run handled itself.
//
// The registry is the run's private directory ($P), and it is append-only: a value once in it stays
// until $P goes. What it holds:
// - secrets/<name>.<digest>.secret (register(), typeSecret(), registerSecret()): one file per value,
//   named by a digest of the value, so a second value under a name is added beside the first and
//   never replaces it;
// - account.json (handover.mjs), browser.json (drive-web.mjs --state) and any other JSON file
//   there: each value under a secret key (password, token, access_token, api_key, …) and each
//   cookie's value. A stored item (a page's localStorage) is app state: it counts when its value is
//   JSON holding a secret key (the phone app's `mend-config` token), when its name is a
//   credential's, or when its value looks like a credential (a known prefix, or 20 or more
//   token characters mixing upper case, lower case and digits); a saved project id or a JSON of
//   preferences does not. Every value is also kept as a secrets/retained-<file>.<digest>.secret the
//   first time it is seen, so a state file rewritten later (new cookies) cannot take an earlier
//   value out;
// - a private file that is not valid JSON: its whole text, as a secret;
// - handover.key and any other `*.secret` or `*.key` file: its whole text.
// A value is kept as written and in the forms an output may encode it in (JSON-escaped,
// URL-encoded). A JSON value (an auth.json kept as a .secret) is kept whole and by each value under
// a secret key, not by its ids and dates; one with no secret key, and any other multiline value,
// is also kept by each line that holds a credential-looking piece (12 characters or more, letters
// and digits both) and by that piece. A line with none (`[default]`,
// `-----BEGIN PRIVATE KEY-----`) is not a secret on its own, and stays readable elsewhere.
//
// The private directory is compared by its real path, however it was spelled (`$P/`, `./private`, a
// symlink): a file is the registry's when its real path is inside the directory's. A directory that
// cannot be resolved is refused, so no helper starts without its registry.
//
// register() refuses a value under 6 characters: one that short cannot be redacted by value without
// redacting ordinary text, so it fails loudly instead of being accepted and silently missed.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, sep } from "node:path";

export const MIN_SECRET_LENGTH = 6;

/** A key whose string value is a credential: `token`, `access_token`, `csrfToken`, `OPENAI_API_KEY`. */
const SECRET_KEY =
  /(?:password|passphrase|passwd|token|secret|api[_-]?key|private[_-]?key|credentials?|authorization|cookie)$/i;
/** A stored item's name that says it holds a credential. */
const SECRET_NAME = /token|secret|password|passwd|credential|auth|session|cookie|api[_-]?key/i;
/** A value shaped like a credential: a known prefix, or a long run of mixed-case token characters. */
const CREDENTIAL_PREFIX = /^(?:mdt_|mdc_|sk-|gh[opsur]_|github_pat_|xox[abprs]-|AKIA|eyJ)/;
const TOKEN_RUN = /^[A-Za-z0-9._~+/=-]{20,}$/;
// A bare UUID is an id the app keeps (the last project, a session), shown on every page that names
// it, never a credential. Registered, it would redact ordinary text and make the scan delete
// evidence captured before the browser state stored it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const credentialShaped = (value) =>
  !UUID.test(value) &&
  (CREDENTIAL_PREFIX.test(value) ||
    (TOKEN_RUN.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)));

/** A JSON object or array, parsed; anything else (a word, a number, not JSON) is null. */
const jsonDocument = (text) => {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * The secret values of a JSON document: each string under a secret key, each cookie's value, and
 * what a stored item (localStorage) holds that is a credential (see the header).
 */
const fromJson = (node, found = [], key = "") => {
  if (typeof node === "string") {
    if (SECRET_KEY.test(key)) found.push(node);
  } else if (Array.isArray(node)) for (const item of node) fromJson(item, found, key);
  else if (node && typeof node === "object") {
    if (typeof node.name === "string" && typeof node.value === "string") {
      const stored = jsonDocument(node.value);
      if (key === "cookies") found.push(node.value);
      else if (stored !== null) fromJson(stored, found);
      else if (SECRET_NAME.test(node.name) || credentialShaped(node.value)) found.push(node.value);
    }
    for (const [name, item] of Object.entries(node))
      if (name !== "value") fromJson(item, found, name);
  }
  return found;
};

const credentialPieces = (line) =>
  line
    .split(/[\s=:,"'`]+/)
    .filter((piece) => piece.length >= 12 && /\d/.test(piece) && /[A-Za-z]/.test(piece));

/**
 * A value, and its forms: encoded, and the values under a JSON value's secret keys, or else, for a
 * multiline value, its credential-looking lines.
 */
export const formsOf = (value) => {
  const forms = new Set([value, value.trim()]);
  const document = jsonDocument(value);
  const keyed = document === null ? [] : fromJson(document);
  const lines = value.split(/\r?\n/);
  if (keyed.length > 0) {
    for (const inner of keyed) for (const form of formsOf(inner)) forms.add(form);
  } else if (lines.length > 1)
    for (const line of lines) {
      const pieces = credentialPieces(line);
      if (pieces.length === 0) continue;
      forms.add(line.trim());
      for (const piece of pieces) forms.add(piece);
    }
  else for (const piece of credentialPieces(value)) forms.add(piece);
  forms.add(JSON.stringify(value).slice(1, -1));
  forms.add(encodeURIComponent(value));
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH);
};

// A link whose target is gone (a browser profile's lock, say) is skipped: it holds nothing to read.
const files = (root) =>
  existsSync(root)
    ? readdirSync(root).flatMap((name) => {
        const path = join(root, name);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          return [];
        }
        return stat.isDirectory() ? files(path) : [path];
      })
    : [];

/** The private directory's real path. Throws, naming only the directory, when it cannot be resolved. */
export const privateRoot = (dir) => {
  try {
    if (typeof dir === "string" && dir !== "" && statSync(dir).isDirectory())
      return realpathSync(dir);
  } catch {
    // Reported below, the same way as a path that is not a directory.
  }
  throw new Error(`the private directory ${dir} cannot be resolved; nothing of the registry read`);
};

const digestOf = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * Add a value to the registry; never replace one. Returns the file it is kept in. Throws (with no
 * value in the message) for a value shorter than MIN_SECRET_LENGTH.
 */
export const register = (dir, name, value) => {
  if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH)
    throw new Error(
      `secret "${name}" refused: under ${MIN_SECRET_LENGTH} characters, it cannot be redacted by value`,
    );
  const at = join(privateRoot(dir), "secrets");
  mkdirSync(at, { recursive: true, mode: 0o700 });
  const path = join(at, `${name.replace(/[^A-Za-z0-9_-]/g, "_")}.${digestOf(value)}.secret`);
  if (!existsSync(path)) writeFileSync(path, value, { mode: 0o600 });
  return path;
};

/** Every secret value in the registry, each with the file it came from, longest first. */
export const loadSecrets = (dir, extra = []) => {
  const root = privateRoot(dir);
  const secrets = new Map();
  const add = (value, source) => {
    for (const form of formsOf(value)) if (!secrets.has(form)) secrets.set(form, source);
  };
  for (const candidate of [...files(root), ...extra]) {
    let path;
    let text;
    try {
      path = realpathSync(candidate);
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const inside = path.startsWith(root + sep);
    const source = inside ? path.slice(root.length + 1) : path;
    if (path.endsWith(".secret") || path.endsWith(".key")) {
      add(text, source);
      continue;
    }
    let values;
    try {
      values = fromJson(JSON.parse(text));
    } catch {
      // Private, and not JSON (truncated state, say): all of it counts as a secret.
      values = [text];
    }
    for (const value of values) {
      if (value.length < MIN_SECRET_LENGTH) continue;
      add(value, source);
      // Kept beside the state file, so a rewrite of that file cannot take it out of the registry.
      if (inside) register(root, `retained-${basename(path)}`, value);
    }
  }
  return new Map([...secrets].toSorted(([a], [b]) => b.length - a.length));
};

/** Every registered value replaced by `<secret>`, longest first, so a part never survives. */
export const redactValues = (text, secrets) => {
  let out = text;
  for (const value of secrets.keys())
    if (out.includes(value)) out = out.split(value).join("<secret>");
  return out;
};
