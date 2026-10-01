import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A private directory for one provider login (docs/adr/0008-one-refresher-for-provider-logins.md):
 * the login is written here, sent to the server and the directory deleted. Under Mend's own config
 * directory rather than the system temp directory: Codex refuses to create its helper binaries
 * under a temp directory and warns on every login.
 */
export const throwawayLoginDir = (parent: string, prefix: string): string => {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
};
