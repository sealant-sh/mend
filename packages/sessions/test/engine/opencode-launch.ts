import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { PROMPT_SCRIPT } from "../../src/agent-command.ts";

/** Execute the emitted prompt command and observe OpenCode's environment after its wrappers. */
export const observeOpencodePrompt = (argv: ReadonlyArray<string>, tmp: string): unknown => {
  const script = argv.indexOf(PROMPT_SCRIPT);
  if (script < 2 || argv[script - 2] !== "sh" || argv[script - 1] !== "-c") {
    throw new Error("no OpenCode prompt command was spawned");
  }
  const home = path.join(tmp, "opencode-observer");
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, "opencode"),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), permission: JSON.parse(process.env.OPENCODE_PERMISSION || "null"), mcp: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}").mcp?.mend }));\n',
    { mode: 0o755 },
  );
  const printed = execFileSync("sh", argv.slice(script - 1), {
    cwd: home,
    env: { HOME: home, PATH: `${home}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  return JSON.parse(printed);
};
