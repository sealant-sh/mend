import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  declaredFlags,
  flagRefusal,
  GROUP_DEFAULTS,
  parseOptionRow,
  ROOT_PAGES,
  VERB_ALIASES,
} from "./flag-gate.ts";
import { type CommandDoc, COMMANDS, findCommand } from "./help.ts";

describe("flagRefusal", () => {
  it.each([
    [
      "dotfiles sync --dry-run",
      "unknown flag --dry-run · usage: mend dotfiles sync [--all | paths...]",
    ],
    ["dotfiles sync --all -- --dry-run", "unknown flag -- · usage: mend dotfiles sync"],
    ["land s --branch --no-pr", "--branch needs a value · usage: mend land <session>"],
    ["server status --bogus", "unknown flag --bogus · usage: mend server status"],
    ["server setup --yes --context -x", "--context needs a value · usage: mend server setup"],
    ["operator org --email a@b", "unknown flag --email · usage: mend operator org list"],
    [
      "ssh keys rm SHA256:x --json",
      "unknown flag --json · usage: mend ssh keys remove <fingerprint>",
    ],
    ["__complete session --bogus", "unknown flag --bogus · usage: mend __complete session"],
    ["--version --bogus", "unknown flag --bogus · usage: mend version"],
    ["codex fix -- --model x", 'unknown flag -- · usage: mend codex ["prompt"]'],
    ["sessions --json=v3", "unknown flag --json=v3 · usage: mend sessions"],
    ["skills push --project=web", "unknown flag --project=web · usage: mend skills push"],
    ["stop -n", "unknown flag -n · usage: mend stop [session-id-prefix]"],
    ["pair --url", "--url needs a value · usage: mend pair [--url <base url>]"],
    ["session --yes", "unknown flag --yes · mend help session lists them"],
    ["operator --email a", "unknown flag --email · mend help operator lists them"],
    ["env bogus --x", "unknown flag --x · mend help env lists them"],
    [
      "worktrees --project p rm x",
      "put flags after the command words · usage: mend worktrees rm <name> [--force] [--project <p>]",
    ],
    [
      "memory --project p rm MEMORY.md",
      "put flags after the command words · usage: mend memory rm <file> [--project <p>]",
    ],
    [
      "skills --project p push",
      "put flags after the command words · usage: mend skills push [--project [p]] [--prune] [--dir <path>]",
    ],
  ])("refuses mend %s", (argv, refusal) => {
    expect(flagRefusal(argv.split(" "))).toContain(refusal);
  });

  it.each([
    [["skills", "push", "--project", "--prune"]],
    [["folder", "--replace", "push", "cfg", "./config"]],
    [["claude", "fix --x", "-d"]],
    [["status", "--json=v2"]],
    [["logs", "-f"]],
    [["env", "cluster", "sa", "--clear"]],
    [["ssh", "status", "--host", "box"]],
    [["ssh", "3f2a", "--host", "box"]],
    [["run", "-d", "--json", "--", "tool", "--unknown", "--help"]],
    [["service", "run", "--port", "3", "--", "pnpm", "dev", "--help"]],
    [["service", "web", "--wait"]],
    [["service", "--wait", "web"]],
    [["logs", "abc", "--follow"]],
    [["run", "--no-land", "--", "make"]],
    [["codex", "--json"]],
    [["codex", "--model", "x", "prompt"]],
    [["operator", "--email", "a", "org", "invite-owner", "acme"]],
    [["uninstall", "--home", "-y"]],
    [["workspace", "replace", "3f2a", "-y"]],
    [["workspace", "-y", "replace", "3f2a"]],
    [["workspace", "--yes", "replace", "3f2a"]],
    [["secrets", "add", ".npmrc", "--from", "-"]],
    [[]],
    [["-v"]],
    [["--help"]],
    [["help", "server", "setup"]],
    [["qr", "--anything"]],
    [["nope", "--anything"]],
    [["--anything"]],
    [["constructor"]],
    [["toString"]],
    [["__proto__"]],
    [["hasOwnProperty"]],
  ])("accepts mend %j", (argv) => {
    expect(flagRefusal(argv)).toBeNull();
  });

  it("names only real pages as root pages, verb alias targets and group defaults", () => {
    for (const name of ROOT_PAGES.values()) {
      expect(findCommand(name.split(" "))?.name, name).toBe(name);
    }
    for (const [, target] of VERB_ALIASES) {
      expect(findCommand(target)?.name, target.join(" ")).toBe(target.join(" "));
    }
    for (const [, name] of GROUP_DEFAULTS) {
      expect(findCommand(name.split(" "))?.name, name).toBe(name);
    }
  });
});

const SYNOPSIS_FLAG = /(?<![\w<-])(--?[a-z][a-z0-9-]*(?:=[a-z0-9]+)?)/g;

const spellingsOf = (docs: ReadonlyArray<ReturnType<typeof findCommand>>): ReadonlySet<string> =>
  new Set(
    docs.flatMap((doc) => (doc === null ? [] : declaredFlags(doc).flatMap((s) => s.spellings))),
  );

describe("the catalog's option rows", () => {
  it("every row parses in the closed grammar", () => {
    for (const doc of COMMANDS) {
      for (const option of doc.options ?? []) {
        expect(parseOptionRow(option.flag), `${doc.name}: ${option.flag}`).not.toBeNull();
      }
    }
  });

  it("every flag in a synopsis is a row of the page or of the sub-page the shape names", () => {
    let seen = 0;
    for (const doc of COMMANDS) {
      for (const shape of doc.synopsis) {
        const [word] = shape.split(" ");
        const named =
          word !== undefined && /^[a-z][a-z-]*$/.test(word)
            ? findCommand([...doc.name.split(" "), word])
            : null;
        const declared = spellingsOf([doc, named]);
        for (const [flag] of shape.matchAll(SYNOPSIS_FLAG)) {
          seen += 1;
          expect(declared.has(flag), `${doc.name}: ${shape} · ${flag}`).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(179);
  });

  it("every example passes the gate", () => {
    for (const doc of COMMANDS) {
      for (const example of doc.examples ?? []) {
        const tokens = example.command.split(/\s+/);
        const argv = tokens.slice(tokens.indexOf("mend") + 1);
        expect(flagRefusal(argv), example.command).toBeNull();
      }
    }
  });
});

type Reads =
  | { readonly pages: ReadonlyArray<string>; readonly childArgv?: ReadonlyArray<string> }
  | "child argv"
  | "copy";

// Every source file of the CLI, so a flag a new file reads is mapped before it ships. The catalog
// and the gate are what is checked against; tests and their fixtures read no user argv.
const NOT_ARGV: ReadonlySet<string> = new Set(["help.ts", "flag-gate.ts"]);

const ARGV_FILES = fs
  .readdirSync(fileURLToPath(new URL(".", import.meta.url)))
  .filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.test\.tsx?$/.test(file) &&
      !/(?:-test-fixtures|\.fixture)\.ts$/.test(file) &&
      !NOT_ARGV.has(file),
  )
  .toSorted();

const SERVER_SETUP = { pages: ["server setup"] };
const CHILD = "child argv";

const READS: Readonly<Record<string, Reads>> = {
  "main.ts hintHerdrAttachment": CHILD,
  "main.ts adopt": { pages: ["adopt"], childArgv: ["--project"] },
  "main.ts attach": { pages: ["attach"] },
  "main.ts stopCommand": { pages: ["stop"] },
  "main.ts serviceAdd": { pages: ["service add"] },
  "main.ts serviceList": { pages: ["service list"] },
  "main.ts SERVICE_RUN_VALUED": { pages: ["service run"] },
  "main.ts serviceWaitOf": { pages: ["service run"] },
  "main.ts serviceRun": { pages: ["service run"] },
  "main.ts serviceLogs": { pages: ["service logs"] },
  "main.ts serviceInit": { pages: ["service init"] },
  "main.ts serviceConnect": { pages: ["service connect"] },
  "main.ts memoryImport": { pages: ["memory import"] },
  "main.ts memoryCommand": { pages: ["memory", "memory show", "memory rm"] },
  "main.ts secretsCommand": { pages: ["secrets add"] },
  "main.ts connectPi": { pages: ["connect pi"] },
  "main.ts connectCommand": { pages: ["connect"] },
  "main.ts dotfilesSync": { pages: ["dotfiles sync"] },
  "main.ts envLoad": { pages: ["env load"] },
  "main.ts envShow": { pages: ["env show"] },
  "main.ts envCluster": { pages: ["env cluster"] },
  "main.ts skillsList": { pages: ["skills"] },
  "main.ts skillsPush": { pages: ["skills push"] },
  "main.ts BASH_COMPLETIONS": "copy",
  "main.ts resumeCommand": { pages: ["resume"] },
  "main.ts rejoinCommand": { pages: ["rejoin"] },
  "main.ts projectsCommand": { pages: ["projects"] },
  "main.ts refreshCommand": { pages: ["refresh"] },
  "main.ts modelsCommand": { pages: ["models"] },
  "message.ts parseMessageArguments": { pages: ["message"] },
  "setup-session.ts parseSetupSessionArgs": { pages: ["setup-session"] },
  "settings.ts parseSettingsArgs": { pages: ["settings"] },
  "main.ts sessionsCommand": { pages: ["sessions"] },
  "main.ts worktreesCommand": { pages: ["worktrees"] },
  "main.ts dashboard": CHILD,
  "main.ts manCommand": CHILD,
  "main.ts main": { pages: ["help", "version", "doctor", "ui", "snake"] },
  "shared.ts CONTINUE_COMMANDS": CHILD,
  "shared.ts parseLaunchArgs": { pages: ["codex", "run"] },
  "shared.ts gitCurrentBranch": CHILD,
  "shared.ts gitTopLevel": CHILD,
  "organization.ts inviteCommand": { pages: ["invite"] },
  "resource-load.ts localDumpPlan": CHILD,
  "resource.ts resourceCommand": {
    pages: [
      "resource list",
      "resource add",
      "resource remove",
      "resource use",
      "resource start",
      "resource stop",
      "resource reset",
      "resource load",
      "resource env",
    ],
  },
  "organization.ts folderCommand": { pages: ["folder push"] },
  "organization.ts operatorCommand": { pages: ["operator org invite-owner"] },
  "pair.ts pairCommand": { pages: ["pair"] },
  "project-retention.ts parseProjectRetentionArgs": { pages: ["projects"] },
  "login.ts browserDecision": { pages: ["login"] },
  "login.ts resolveServerUrl": { pages: ["login"] },
  "ssh-setup.ts showStatus": { pages: ["ssh"] },
  "ssh-setup.ts setup": { pages: ["ssh setup"] },
  "ssh-setup.ts sessionSsh": { pages: ["ssh"] },
  "ssh-setup.ts listKeys": { pages: ["ssh keys"] },
  "ssh-setup.ts keysCommand": { pages: ["ssh keys"] },
  "shared-workspace.ts confirmPlan": { pages: ["session share", "workspace replace"] },
  "uninstall.ts parseUninstallArgs": { pages: ["uninstall"] },
  "uninstall.ts dockerIn": CHILD,
  "uninstall.ts dockerProblemOn": CHILD,
  "uninstall.ts volumeOwner": CHILD,
  "uninstall.ts listNamesIn": CHILD,
  "uninstall.ts findWorkspaces": CHILD,
  "uninstall.ts composeServices": CHILD,
  "uninstall.ts serverPresent": CHILD,
  "uninstall.ts readSysctlFile": CHILD,
  "uninstall.ts findImages": CHILD,
  "uninstall.ts buildCacheSize": CHILD,
  "uninstall.ts findLeftovers": CHILD,
  "uninstall.ts describeUninstall": CHILD,
  "uninstall.ts removeWorkspaceContainers": CHILD,
  "uninstall.ts removeServer": CHILD,
  "uninstall.ts removeLeftovers": CHILD,
  "uninstall.ts removeHostExtras": CHILD,
  "uninstall.ts clearBuildCache": CHILD,
  "worktree-remove.ts parseWorktreesRmArgs": { pages: ["worktrees rm"] },
  "doctor-bundle.ts parseBundleArgs": { pages: ["doctor"] },
  "dotfiles.ts VALUE_FLAGS": { pages: ["dotfiles repo"] },
  "dotfiles.ts parseDotfilesRepoArgs": { pages: ["dotfiles repo"] },
  "landing.ts parseLandArgs": { pages: ["land"] },
  "landing.ts parsePullArgs": { pages: ["pull"] },
  "landing.ts gitRemotes": CHILD,
  "landing.ts commitAt": CHILD,
  "landing.ts treeAndParents": CHILD,
  "landing.ts fetchBundle": CHILD,
  "handoff.ts parseHandoffArgs": { pages: ["handoff"] },
  // The `mend <harness>` command a handoff prints when its launch did not start.
  "handoff.ts sendFrom": { pages: ["codex"] },
  "run-scripts.ts interactiveShellIssue": CHILD,
  "run-scripts.ts parseLogsArgs": { pages: ["logs"] },
  "run-scripts.ts parseWaitArgs": { pages: ["wait"] },
  "server-setup.ts SETUP_FLAGS": SERVER_SETUP,
  "server-setup.ts SWITCHES": SERVER_SETUP,
  "server-setup.ts REPEATABLE": SERVER_SETUP,
  "server-setup.ts parseDeclared": SERVER_SETUP,
  "server-setup.ts parseHostFlag": SERVER_SETUP,
  "server-setup.ts parseEdge": SERVER_SETUP,
  "server-setup.ts parseSetupOptions": SERVER_SETUP,
  "server-setup.ts HOST_FLAGS": SERVER_SETUP,
  "server-setup.ts ENGINE_FLAGS": SERVER_SETUP,
  "server-setup.ts resolveAppUrl": SERVER_SETUP,
  "server-setup.ts checkExposurePair": SERVER_SETUP,
  "server-setup.ts validateExposure": SERVER_SETUP,
  "server-setup.ts selectDockerContext": CHILD,
  "server-setup.ts checkDocker": CHILD,
  "server-setup.ts observeHostUserNamespaces": CHILD,
  "server-setup.ts rootlessDaemon": CHILD,
  "server-setup.ts allowHostUserNamespaces": CHILD,
  "server-setup.ts inspectImage": CHILD,
  "server-setup.ts checkLocalImages": CHILD,
  "server-setup.ts checkComposeImages": CHILD,
  "server-setup.ts initGarage": CHILD,
  "server-setup.ts removeStrayService": CHILD,
  "server-setup.ts startCompose": CHILD,
  "server-setup.ts validateEdge": CHILD,
  "server-setup.ts readTailscale": CHILD,
  "server-setup.ts mendIn": CHILD,
  "server-setup.ts observeDockerEngines": CHILD,
  "server-setup.ts settleDockerEngine": CHILD,
  "server-setup.ts setupServer": CHILD,
  "server-setup.ts composeCommand": CHILD,
  "server-setup.ts startInstallation": CHILD,
  "server-setup.ts parseUpgradeOptions": { pages: ["server upgrade"] },
  "server-setup.ts psqlRows": CHILD,
  "server-setup.ts checkPreviewMigrations": CHILD,
  "server-setup.ts upgradeServer": CHILD,
  "server-setup.ts observeEdgeCertificate": CHILD,
  "server-setup.ts mirrorStatusLines": CHILD,
  "server-setup.ts serverStatus": CHILD,
  "server-setup.ts manageServer": {
    pages: ["server logs", "server start", "server restart"],
    childArgv: ["--no-color", "--timeout"],
  },
  "doppler.ts dopplerCommand": { pages: ["doppler use"] },
  "doppler.ts readDopplerLocalConfig": CHILD,
  "git-author.ts parseGitAuthorArgs": { pages: ["git-author"] },
  "claude-grant.ts forgetGrant": CHILD,
  "claude-grant.ts grantStatus": CHILD,
  "claude-grant.ts readGrant": CHILD,
  "claude-grant.ts runClaudeLogin": CHILD,
  "clipboard.ts fromMac": CHILD,
  "clipboard.ts fromWayland": CHILD,
  "clipboard.ts fromX11": CHILD,
  "codex-grant.ts runCodexDeviceLogin": CHILD,
  "docker-shutdown.ts hostDockerDaemonFacts": CHILD,
  "docker-shutdown.ts hostDockerEndpoint": CHILD,
  "docker-shutdown.ts hostFlags": CHILD,
  "docker-shutdown.ts observeHostDockerStop": CHILD,
  "doctor-bundle-collectors.ts CONTAINER_FILTERS": CHILD,
  "doctor-bundle-collectors.ts dockerFactsOnce": CHILD,
  "doctor-bundle-collectors.ts serverLogsCollector": CHILD,
  "doctor-bundle-collectors.ts toolsCollector": CHILD,
  "doctor-bundle-collectors.ts workspaceLogsCollector": CHILD,
  "doctor.ts readMacLid": CHILD,
  "doctor.ts readMacPowerSettings": CHILD,
  "server-docker-volumes.ts docker": CHILD,
  "server-docker-volumes.ts ensureVolume": CHILD,
  "server-docker-volumes.ts inspectOwner": CHILD,
  "server-docker-volumes.ts inspectResource": CHILD,
  "server-docker-volumes.ts listNames": CHILD,
  "server-docker-volumes.ts removeServerLeftovers": CHILD,
  "server-mirrors.ts npmMirrorService": CHILD,
  "server-runtime.ts serverComposeArgs": CHILD,
  // The `mend server setup` command a guide prints for the operator to run.
  "server-setup-guide.ts flagsFor": SERVER_SETUP,
  "server-setup-guide.ts previewFlagsFor": SERVER_SETUP,
  "server-setup-guide.ts setupCommandOf": SERVER_SETUP,
  // The setup flag that turns off previews a pinned server image cannot serve.
  "server-preview.ts PREVIEW_CAPABILITIES": SERVER_SETUP,
};

const DECLARATION = /^(?:export )?(?:const|let|function|async function) ([A-Za-z_$][\w$]*)/;
const FLAG_LITERAL = /"(--?[a-zA-Z][a-zA-Z0-9=-]*)"/g;

const sourceOf = (file: string): string =>
  fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const flagLiterals = (): ReadonlyMap<string, ReadonlySet<string>> => {
  const found = new Map<string, Set<string>>();
  for (const file of ARGV_FILES) {
    let current = "(module)";
    for (const line of sourceOf(file).split("\n")) {
      const declaration = DECLARATION.exec(line);
      if (declaration?.[1] !== undefined) current = declaration[1];
      for (const [, literal] of line.matchAll(FLAG_LITERAL)) {
        if (literal === undefined) continue;
        const key = `${file} ${current}`;
        const set = found.get(key) ?? new Set<string>();
        set.add(literal);
        found.set(key, set);
      }
    }
  }
  return found;
};

const valueWordFor = (docs: ReadonlyArray<CommandDoc | null>, literal: string): string[] => {
  const spec = docs
    .flatMap((doc) => (doc === null ? [] : declaredFlags(doc)))
    .find((candidate) => candidate.spellings.includes(literal));
  return spec?.value === "required" ? ["value"] : [];
};

const mainFunctionSource = (): string => {
  const source = sourceOf("main.ts");
  const start = source.indexOf("\nconst main = async () => {");
  const end = source.indexOf("\n};\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

const DISPATCHED_WORD = /\bcase "([^"]+)":|command === "([^"]+)"/g;
const FREE_TEXT: ReadonlySet<string> = new Set(["qr", "message"]);

describe("the regression lever", () => {
  const literals = flagLiterals();

  it("maps every function that reads a flag literal, and nothing that does not", () => {
    expect([...literals.keys()].toSorted()).toEqual(Object.keys(READS).toSorted());
  });

  it("finds flags in the files it reads", () => {
    expect(literals.get("main.ts skillsPush")).toEqual(new Set(["--dir", "--project", "--prune"]));
  });

  it("every literal a mapped function reads passes the gate on one of its pages", () => {
    for (const [key, reads] of Object.entries(READS)) {
      if (reads === "child argv" || reads === "copy") continue;
      const docs = reads.pages.map((name) => findCommand(name.split(" ")));
      for (const [index, doc] of docs.entries()) {
        expect(doc?.name, `${key}: ${reads.pages[index]}`).toBe(reads.pages[index]);
      }
      const child = new Set(reads.childArgv ?? []);
      for (const literal of literals.get(key) ?? []) {
        if (child.has(literal)) continue;
        const ownParser = docs.find((doc) => doc?.parsesOwnFlags === true);
        if (ownParser !== undefined && ownParser !== null) {
          expect(
            literal === "--" || spellingsOf([ownParser]).has(literal),
            `${key}: ${literal} is not a row of ${ownParser.name}`,
          ).toBe(true);
          continue;
        }
        const root = ROOT_PAGES.get(literal);
        const argvs =
          root !== undefined && reads.pages.includes(root)
            ? [[literal]]
            : reads.pages.map((name) => [
                ...name.split(" "),
                literal,
                ...valueWordFor(docs, literal),
              ]);
        const refusals = argvs.map((argv) => `mend ${argv.join(" ")} → ${flagRefusal(argv)}`);
        expect(
          argvs.some((argv) => flagRefusal(argv) === null),
          `${key}: ${literal}\n${refusals.join("\n")}`,
        ).toBe(true);
      }
      for (const literal of child) {
        expect(literals.get(key)?.has(literal), `${key}: ${literal} is no longer read`).toBe(true);
      }
    }
  });

  it("every command word main() dispatches is gated, except the free-text ones", () => {
    const words = [...mainFunctionSource().matchAll(DISPATCHED_WORD)].flatMap(([, label, test]) =>
      label === undefined ? (test === undefined ? [] : [test]) : [label],
    );
    expect(words.length).toBeGreaterThan(40);
    expect(words).toContain("server");
    for (const word of words) {
      const refusal = flagRefusal([word, "--surely-not-a-flag"]);
      if (FREE_TEXT.has(word)) expect(refusal, word).toBeNull();
      else expect(refusal, word).not.toBeNull();
    }
  });
});
