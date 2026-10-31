import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { dopplerTokenIssue } from "@mend/domain/workbench";
import { originMatches } from "@mend/local-git/origin";
import { Redacted, Schema } from "effect";
import { parse } from "yaml";

import { usageOf } from "./help.ts";
import type { ApiCall } from "./pair.ts";
import { cwdFacts, matchProjectByCwd, takeFlagValue } from "./shared.ts";

const Scope = Schema.Struct({
  token: Schema.optionalKey(Schema.String),
  "enclave.project": Schema.optionalKey(Schema.String),
  "enclave.config": Schema.optionalKey(Schema.String),
});
const Scopes = Schema.Record(Schema.String, Scope);
export interface DopplerLocalConfig {
  readonly token: Redacted.Redacted<string>;
  readonly scopes: ReadonlyArray<{
    readonly directory: string;
    readonly dopplerProject: string;
    readonly config: string;
  }>;
}

/** Parse locally, without putting malformed YAML or a credential into an error. */
export const parseDopplerLocalConfig = (contents: string, cwd: string): DopplerLocalConfig => {
  let input: unknown;
  try {
    input = parse(contents);
  } catch {
    throw new Error("Doppler's local config could not be read. Run doppler login first.");
  }
  const scoped =
    typeof input === "object" && input !== null && "scoped" in input ? input.scoped : input;
  const decoded = Schema.decodeUnknownExit(Scopes)(scoped);
  if (decoded._tag === "Failure")
    throw new Error("Doppler's local config could not be read. Run doppler login first.");
  const entries = Object.entries(decoded.value).toSorted(([a], [b]) => b.length - a.length);
  const token = entries.find(
    ([directory, options]) =>
      options.token &&
      (cwd === directory || cwd.startsWith(directory.endsWith("/") ? directory : `${directory}/`)),
  )?.[1].token;
  if (token === undefined || token.startsWith("secret-") || dopplerTokenIssue(token) !== null)
    throw new Error("No local Doppler token found. Run doppler login first.");
  return {
    token: Redacted.make(token),
    scopes: entries.flatMap(([directory]) => {
      const parents = entries.filter(
        ([parent]) =>
          directory === parent ||
          directory.startsWith(parent.endsWith("/") ? parent : `${parent}/`),
      );
      const dopplerProject = parents.find(([, options]) => options["enclave.project"])?.[1][
        "enclave.project"
      ];
      const config = parents.find(([, options]) => options["enclave.config"])?.[1][
        "enclave.config"
      ];
      return dopplerProject && config ? [{ directory, dopplerProject, config }] : [];
    }),
  };
};

/** File import works without a Doppler binary. The CLI fallback also supports configured paths. */
export const readDopplerLocalConfig = (home: string, cwd: string): DopplerLocalConfig => {
  const result = spawnSync("doppler", ["configure", "--all", "--json", "--no-check-version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home },
  });
  if (result.status === 0) return parseDopplerLocalConfig(result.stdout, cwd);
  // Without the CLI, raw tokens still import. A keyring reference requires the CLI to resolve it.
  try {
    return parseDopplerLocalConfig(
      fs.readFileSync(path.join(home, ".doppler/.doppler.yaml"), "utf8"),
      cwd,
    );
  } catch {
    throw new Error(
      "No local Doppler token found. Run doppler login first. Keyring logins need the Doppler CLI.",
    );
  }
};

interface Project {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
  readonly storePath: string;
}

/** Import directory scopes by repository identity, never by a laptop's filesystem path. */
export const dopplerImports = (
  local: DopplerLocalConfig,
  projects: ReadonlyArray<Project>,
): ReadonlyArray<{
  readonly projectId: string;
  readonly dopplerProject: string;
  readonly config: string;
}> => {
  const selected = new Map<string, { projectId: string; dopplerProject: string; config: string }>();
  for (const scope of local.scopes.toSorted((a, b) => a.directory.length - b.directory.length)) {
    const remote = cwdFacts(scope.directory).originUrl;
    if (remote === null) continue;
    const matches = projects.filter(
      (project) =>
        project.originUrl !== null && originMatches(remote, project.originUrl, scope.directory),
    );
    const project = matches.length === 1 ? matches[0] : undefined;
    if (project !== undefined && !selected.has(project.id))
      selected.set(project.id, {
        projectId: project.id,
        dopplerProject: scope.dopplerProject,
        config: scope.config,
      });
  }
  return [...selected.values()];
};

/** Laptop command. Workspaces use their person-bound Mend helper on the session channel. */
export const dopplerCommand = async (
  api: ApiCall,
  args: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const [verb = "status", ...rest] = args;
  if (verb === "connect") {
    const local = readDopplerLocalConfig(os.homedir(), process.cwd());
    const projects = await api<ReadonlyArray<Project>>("GET", "/projects");
    await api("PUT", "/me/doppler", { token: Redacted.value(local.token) });
    const mappings = dopplerImports(local, projects);
    for (const mapping of mappings)
      await api("PUT", `/me/doppler/projects/${mapping.projectId}`, {
        dopplerProject: mapping.dopplerProject,
        config: mapping.config,
      });
    return [
      `Doppler connected · ${mappings.length} project mappings imported`,
      ...mappings.map(
        (mapping) =>
          `${projects.find((project) => project.id === mapping.projectId)?.name ?? mapping.projectId} · ${mapping.dopplerProject}/${mapping.config}`,
      ),
    ];
  }
  if (verb === "use") {
    const explicit = takeFlagValue(rest, "--project");
    const positional = rest.filter(
      (word, i) => !word.startsWith("--") && rest[i - 1] !== "--project",
    );
    const [dopplerProject, config] = positional;
    if (dopplerProject === undefined || config === undefined || positional.length !== 2)
      throw new Error(usageOf("doppler use"));
    const projects = await api<ReadonlyArray<Project>>("GET", "/projects");
    const project =
      explicit === null
        ? matchProjectByCwd(projects, cwdFacts(process.cwd()))
        : projects.find((item) => item.name === explicit || item.id === explicit);
    if (project === undefined)
      throw new Error("Choose a Mend project with --project, or run inside its checkout.");
    await api("PUT", `/me/doppler/projects/${project.id}`, { dopplerProject, config });
    return [`${project.name} · Doppler ${dopplerProject}/${config}`];
  }
  if (verb === "disconnect") {
    await api("DELETE", "/me/doppler");
    return ["Doppler disconnected · token and mappings removed from Mend"];
  }
  if (verb !== "status") throw new Error(usageOf("doppler"));
  const status = await api<{
    connected: boolean;
    name: string | null;
    updatedAt: string | null;
    mappings: ReadonlyArray<{ projectName: string; dopplerProject: string; config: string }>;
  }>("GET", "/me/doppler");
  return [
    status.connected
      ? `Doppler connected${status.updatedAt === null ? "" : ` · updated ${status.updatedAt}`}`
      : "Doppler not connected · mend doppler connect after doppler login",
    ...status.mappings.map(
      (mapping) => `${mapping.projectName} · ${mapping.dopplerProject}/${mapping.config}`,
    ),
  ];
};
