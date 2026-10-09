import { workspaceRetirementLine } from "@mend/domain/workbench";

import type { ApiCall } from "./pair.ts";
import {
  askYesNo,
  confirmPlan,
  launcherNameOf,
  replaceConfirmLines,
  type LivePersonDto,
  type MemberNameDto,
  type WorkspaceRetirementDto,
} from "./shared-workspace.ts";
import { redactCredentials } from "./shared.ts";

/**
 * `mend workspace replace <session>` (docs/adr/0016-per-person-harness-homes.md, decision 14):
 * "Replace this workspace now" from a terminal. The change's owner replaces an executor that
 * started before per-person homes, after it says what was checked and what would stop; the
 * replacement names that read (`seen`), the server decides, and a refusal is printed in its own
 * words.
 */

const paint = (code: string) => (text: string) =>
  process.stdout.isTTY === true ? `\u001b[${code}m${text}\u001b[0m` : text;
const dim = paint("2");
const green = paint("32");
const say = (line: string) => process.stdout.write(`${redactCredentials(line)}\n`);
const fail = (message: string): never => {
  process.stderr.write(`mend: ${redactCredentials(message)}\n`);
  process.exit(1);
};

export const WORKSPACE_REPLACE_USAGE = "usage: mend workspace replace <session> [--yes]";

interface SessionRowDto {
  readonly id: string;
  readonly harness: string;
  readonly livePeople?: ReadonlyArray<LivePersonDto>;
}

export interface WorkspaceCommandIo {
  /** Whether a person is at the terminal to answer. */
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<boolean>;
}

const terminalIo = (): WorkspaceCommandIo => ({
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  ask: askYesNo,
});

export const workspaceCommand = async (
  api: ApiCall,
  /** The same call, throwing instead of exiting, so an older server's 404 reads as nothing. */
  tryApi: ApiCall,
  args: ReadonlyArray<string>,
  io: WorkspaceCommandIo = terminalIo(),
) => {
  const [verb, prefix] = args.filter((arg) => !arg.startsWith("-"));
  if (verb !== "replace" || prefix === undefined) return fail(WORKSPACE_REPLACE_USAGE);
  const sessions = await api<ReadonlyArray<SessionRowDto>>("GET", "/sessions?retained=1");
  const matches = sessions.filter((session) => session.id.startsWith(prefix));
  if (matches.length > 1) {
    return fail(`"${prefix}" matches ${matches.length} sessions; type more of the id`);
  }
  const [session] = matches;
  if (session === undefined) return fail(`no live session starts with "${prefix}"`);
  const retirement = await tryApi<WorkspaceRetirementDto | null>(
    "GET",
    `/sessions/${session.id}/workspace-retirement`,
  ).catch(() => null);
  if (retirement !== null) {
    const members = await tryApi<ReadonlyArray<MemberNameDto>>(
      "GET",
      "/organization/members",
    ).catch(() => []);
    say(
      dim(
        workspaceRetirementLine(
          retirement,
          launcherNameOf(retirement.launcher, session.livePeople ?? [], members),
        ),
      ),
    );
    for (const line of replaceConfirmLines(retirement)) say(line);
    // Nothing to confirm without a replacement waiting: the server says so in its own words.
    const plan = confirmPlan(args, io.interactive);
    if (plan === "refuse") return fail("non-interactive · pass --yes to replace the workspace");
    if (plan === "ask" && !(await io.ask("replace it?"))) {
      say(dim("nothing replaced"));
      return;
    }
  }
  // The fingerprint of the very read it showed: the server ends nothing that was not listed,
  // and refuses in its own words when more would stop now. Without a read there is nothing it
  // showed, and the server says why in its own words.
  await api("POST", `/sessions/${session.id}/workspace-retirement/replace`, {
    seen: retirement?.fingerprint ?? "",
  });
  say(
    `${green("✓")} ${workspaceRetirementLine({ state: "retiring", preRelease: retirement?.preRelease ?? true, reason: null }, "")} ${dim(`· ${session.harness} ${session.id.slice(0, 8)}`)}`,
  );
};
