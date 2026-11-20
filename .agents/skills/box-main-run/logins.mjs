#!/usr/bin/env node
// When the agent logins in the run's saved data expire, and whether each is held against refresh
// (SKILL.md, steps 1 and 6). Reads a pg_dumpall file and the install identity that seals its
// logins, both on this machine, and prints one line per active Codex or Claude login with times
// only: never a token, a key or an email.
//
//   node .agents/skills/box-main-run/logins.mjs [<world.sql> <identity.env>]
//
// Defaults to the data the next master is built from: ~/.local/share/mend-check-vms/box/world.sql
// and identity.env beside it. Each line:
//
//   login <provider> <kind> · access expires <UTC> (in <h> h) · refreshed <UTC> · held|free
//
// `held` means the data holds the login against refresh (vm save's claim), so only the run's own
// copy, which lifts it (refresher.sh lift), refreshes it. Exit 0; 2 when the files cannot be read.
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const box = join(
  process.env.MEND_CHECK_VMS ?? join(homedir(), ".local/share/mend-check-vms"),
  "box",
);
const [dump = join(box, "world.sql"), identity = join(box, "identity.env")] = process.argv.slice(2);

let lines;
let key;
try {
  lines = readFileSync(dump, "utf8").split("\n");
  const raw = readFileSync(identity, "utf8").match(/^SEALANT_CREDENTIALS_KEY=(.*)$/m)?.[1] ?? "";
  key = Buffer.from(raw.trim().replace(/^['"]|['"]$/g, ""), "base64");
} catch (error) {
  console.error(`logins.mjs: ${error.message}`);
  process.exit(2);
}
const header = lines.findIndex((line) => line.startsWith("COPY public.connected_accounts "));
if (header < 0 || key.length !== 32) {
  console.error("logins.mjs: no connected_accounts in the dump, or no credentials key");
  process.exit(2);
}
const columns = lines[header]
  .slice(lines[header].indexOf("(") + 1, lines[header].indexOf(")"))
  .split(", ");

const open = (sealed) => {
  const [, , iv, tag, body] = sealed.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString(),
  );
};
const claims = (jwt) => {
  try {
    return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
};
const at = (ms) =>
  Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16) + "Z" : "unknown";
const hours = (ms) =>
  Number.isFinite(ms) ? `${Math.round((ms - Date.now()) / 360_000) / 10} h` : "?";

for (const line of lines.slice(header + 1)) {
  if (line === "\\.") break;
  const row = Object.fromEntries(line.split("\t").map((value, n) => [columns[n], value]));
  if (row.archived_at !== "\\N" || !["auth-json", "credentials-json"].includes(row.kind)) continue;
  let expires = Number.NaN;
  let refreshed = Number.NaN;
  try {
    const payload = open(row.encrypted_payload);
    if (row.kind === "auth-json") {
      const auth = JSON.parse(payload.authJson);
      expires = (claims(auth.tokens?.access_token).exp ?? Number.NaN) * 1000;
      refreshed = Date.parse(auth.last_refresh);
    } else {
      const grant = JSON.parse(payload.credentialsJson).claudeAiOauth ?? {};
      expires = Number(grant.expiresAt);
      refreshed = Date.parse(`${row.last_synced_at.replace(" ", "T").replace(/\+00$/, "")}Z`);
    }
  } catch {
    // An unreadable payload prints as unknown times.
  }
  const claim = row.refresh_claimed_until;
  const held =
    claim !== "\\N" &&
    Date.parse(claim.replace(" ", "T").replace(/\+00$/, "Z")) > Date.parse("2900-01-01");
  console.log(
    `login ${row.provider} ${row.kind} · ${row.status} · access expires ${at(expires)} (in ${hours(expires)}) · refreshed ${at(refreshed)} · ${held ? "held" : "free"}`,
  );
}
