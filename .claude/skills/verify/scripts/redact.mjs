#!/usr/bin/env node
// The verify skill's shape redaction: every credential shape Mend shows or prints, and the common
// provider credential shapes a run may paste, replaced by its kind. One list, used by drive-web.mjs
// (ARIA snapshots, steps, errors), capture.sh (CLI transcripts), settle.mjs (server logs) and
// scan-evidence.mjs (which looks for what slipped through). Shapes are the second line: a value the
// run held or typed is redacted by value first (secrets.mjs), whatever its shape.
//
//   node .claude/skills/verify/scripts/redact.mjs [--secrets <private dir> [--register-minted]] < in > out
//
// With --secrets, every value in the run's registry is redacted too, before the shapes. With
// --register-minted, every code the text shows (mintedCodes: `mend login`'s authorization code and
// its /authorize?code= link, a pairing code) joins the registry by value first.
//
// Sources: invitation and reset links (apps/web routes join.$token, reset.$token), device tokens
// `mdt_` and pairing secrets `mdc_` (apps/api routes/devices.ts), the `mend://pair?…&c=…` payload
// and its grouped `XXXX-XXXX` code, printed by `mend pair` or standing alone in a snapshot node
// (apps/cli pair.ts, apps/web pairing-qr.tsx), `mend login`'s authorization code (`code  XXXX-XXXX`)
// and its `/authorize?code=` link (apps/cli login.ts, apps/api routes/devices.ts), bearer headers, signed upload URLs, PEM private
// keys, Anthropic, OpenAI, GitHub, Slack and AWS key shapes, and token, password, secret and API
// key fields in JSON or key=value text.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadSecrets, redactValues, register } from "./secrets.mjs";

/** Each shape, the text that replaces it, and its kind (scan-evidence.mjs names hits by kind). */
export const CREDENTIAL_PATTERNS = [
  {
    kind: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: "<private key>",
  },
  { kind: "invitation link", pattern: /\/join\/[A-Za-z0-9_-]{8,}/g, replace: "/join/<token>" },
  {
    kind: "password reset link",
    pattern: /\/reset\/[A-Za-z0-9_-]{8,}/g,
    replace: "/reset/<token>",
  },
  {
    kind: "pairing link",
    pattern: /mend:\/\/pair\?[^\s"'<>]+/g,
    replace: "mend://pair?<redacted>",
  },
  { kind: "device token", pattern: /\bmdt_[A-Za-z0-9_-]{8,}/g, replace: "mdt_<token>" },
  { kind: "pairing secret", pattern: /\bmdc_[A-Za-z0-9_-]{8,}/g, replace: "mdc_<token>" },
  {
    kind: "pairing code",
    pattern: /(\bpairing code\s+)[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g,
    replace: "$1<pairing code>",
  },
  {
    kind: "authorization code",
    pattern: /(\bcode\s+)[0-9A-Z]{4}-[0-9A-Z]{4}\b/g,
    replace: "$1<authorization code>",
  },
  {
    kind: "authorization link",
    pattern: /([?&]code=)[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}\b/g,
    replace: "$1<code>",
  },
  // A snapshot node whose whole text is a grouped code: how the web shows a pairing code. The same
  // shape inside a name or an id (a run name, a UUID) is not a node of its own, and stays.
  {
    kind: "pairing code",
    pattern: /(:\s*"?)[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}("?\s*)$/gm,
    replace: "$1<pairing code>$2",
  },
  {
    kind: "provider key",
    pattern:
      /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g,
    replace: "<provider key>",
  },
  { kind: "bearer token", pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "$1 <token>" },
  {
    kind: "signed URL",
    pattern:
      /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|sig|token|access_token)=)[^&\s"']+/gi,
    replace: "$1<redacted>",
  },
  {
    kind: "credential field",
    pattern:
      /(["']?[A-Za-z_]*(?:token|password|secret|api_?key|authorization|cookie)[A-Za-z_]*["']?\s*[:=]\s*["']?)(?!<|Bearer\b)[^"'\s,}]{6,}/gi,
    replace: "$1<redacted>",
  },
];

/**
 * Every code the text shows that a device or a sign-in is approved with, grouped (`K7QZ-3MXP`) and
 * bare (`K7QZ3MXP`): register them, so they are redacted by value wherever they turn up next.
 */
export const mintedCodes = (text) => {
  const codes = new Set();
  const found = [
    ...text.matchAll(/\bcode\s+([0-9A-Z]{4})-([0-9A-Z]{4})\b/g),
    ...text.matchAll(/[?&]code=([0-9A-Za-z]{4})-?([0-9A-Za-z]{4})\b/g),
    ...text.matchAll(/(?:^|:\s*"?)([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z]{4})"?\s*$/gm),
  ];
  for (const [, head, tail] of found) {
    codes.add(`${head}-${tail}`.toUpperCase());
    codes.add(`${head}${tail}`.toUpperCase());
  }
  return [...codes];
};

export const redact = (text) =>
  CREDENTIAL_PATTERNS.reduce((out, { pattern, replace }) => out.replace(pattern, replace), text);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--secrets");
  const text = readFileSync(0, "utf8");
  if (at !== -1 && process.argv.includes("--register-minted"))
    for (const code of mintedCodes(text)) register(process.argv[at + 1], "minted-code", code);
  const secrets = at === -1 ? new Map() : loadSecrets(process.argv[at + 1]);
  process.stdout.write(redact(redactValues(text, secrets)));
}
