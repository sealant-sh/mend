// What engine-person-runtime, -conversations and -executors share (docs/adr/0016): the command a
// person's exec runs, and a person's Claude transcript written under a harness home.

import * as fs from "node:fs";
import * as path from "node:path";

/** The command a person's exec runs, past its umask and the session it names (`personExecPrefix`). */
export const commandOf = (argv: ReadonlyArray<string>) => {
  if (argv[3] !== "mend-as-person" || !(argv[5] ?? "").startsWith("MEND_SESSION_ID=")) return argv;
  // Past the environment it names: the session, and a one-off write's own token file.
  let at = 6;
  while ((argv[at] ?? "").startsWith("MEND_SESSION_TOKEN_FILE=")) at++;
  return argv.slice(at);
};

/** One line of a Claude transcript (Delivery 16's tests). */
export const claudeLine = (id: string, text: string) =>
  `${JSON.stringify({
    type: "user",
    sessionId: id,
    cwd: "/workspace/repo",
    message: { role: "user", content: text },
  })}\n`;

export const PROJECT_DIR = ".claude/projects/-workspace-repo";

export const writeUnder = (root: string, relative: string, contents: string) => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), contents);
};

/** A person's saved directory, under a harness home. */
export const peopleDir = (account: string) => `people/${account}`;
