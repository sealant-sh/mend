import * as fs from "node:fs";
import * as path from "node:path";

import {
  type LoginClass,
  loginChoiceOf,
  narrowCredential,
  repositoryCloneUrlIssue,
  parseDuration,
  validatePiProfile,
} from "@mend/domain/workbench";

import { needsInput, readinessResult, type CommandResult } from "./command-result.ts";
import type { ApiCall } from "./pair.ts";
import { piAgentDir, scanPiProfile } from "./pi-profile.ts";
import { providerLogin } from "./provider-login.ts";
import {
  cwdFacts,
  endpointOption,
  gitOriginUrl,
  matchProjectByCwd,
  normalizeProjectName,
  takeFlagValue,
} from "./shared.ts";

interface Project {
  readonly id: string;
  readonly name: string;
  readonly originUrl: string | null;
  readonly storePath: string;
  readonly defaultBranch: string;
  readonly gitAuthMode: string;
}

interface Account {
  readonly id: string;
  readonly provider: "claude" | "codex" | "github";
  readonly name: string;
  readonly status: "active" | "invalid" | "archived";
  readonly isDefault: boolean;
  readonly login?: LoginClass | undefined;
}

const usage = (message: string, fix: string): CommandResult<never> => ({
  status: "usage",
  error: { code: "usage", message, fix },
});

/** Adopt through the same projects route as the terminal command, without its optional picker. */
export const adoptJson = async (
  api: ApiCall,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  if (args.includes("--private") && args.includes("--shared"))
    return usage("Choose one visibility.", "Pass --private or --shared.");
  const name = takeFlagValue(args, "--name");
  const auth = takeFlagValue(args, "--auth");
  if (auth !== null && auth !== "mend-key" && auth !== "bridge")
    return usage("Unknown Git authentication mode.", "Pass --auth mend-key or --auth bridge.");
  const positional = args.filter(
    (word, index) =>
      !word.startsWith("--") && args[index - 1] !== "--name" && args[index - 1] !== "--auth",
  );
  if (positional.length > 1)
    return usage("Adopt takes one repository URL.", "Run mend adopt <git-url> --json.");
  const source = positional[0] ?? gitOriginUrl(process.cwd());
  if (source === null)
    return needsInput(
      "No repository URL or checkout origin was found.",
      "Run mend adopt <git-url> --json.",
    );
  const issue = repositoryCloneUrlIssue(source);
  if (issue !== null) return usage(issue, "Pass a network Git URL to mend adopt <git-url> --json.");
  const project = await api<Project>("POST", "/projects", {
    name: name ?? normalizeProjectName(path.basename(source, ".git")),
    source,
    visibility: args.includes("--shared") ? "shared" : "private",
    ...(auth === null ? {} : { gitAuthMode: auth }),
  });
  return {
    status: "done",
    data: {
      project: {
        id: project.id,
        name: project.name,
        defaultBranch: project.defaultBranch,
        gitAuthMode: project.gitAuthMode,
      },
    },
  };
};

/** Resolve projects using the same explicit name and checkout-origin matching as launches. */
export const resolveOnboardingProject = async (
  api: ApiCall,
  explicit: string | null,
): Promise<Project | null> => {
  const projects = await api<ReadonlyArray<Project>>("GET", "/projects");
  return explicit === null
    ? (matchProjectByCwd(projects, cwdFacts(process.cwd())) ?? null)
    : (projects.find((p) => p.id === explicit || p.name === explicit) ?? null);
};

/** Report selected logins; pi uses the Codex login and has a separately saved profile. */
export const connectStatusJson = async (api: ApiCall): Promise<CommandResult<unknown>> => {
  const identity = await api<{ readonly accounts: ReadonlyArray<Account> }>("GET", "/me/sealant");
  const profile = await api<{ readonly profile: { readonly revision: number } | null }>(
    "GET",
    "/me/pi-profile",
  );
  const selected = (provider: "claude" | "codex") => {
    const choice = loginChoiceOf(identity.accounts, provider);
    return {
      provider,
      connected: choice._tag === "chosen" && choice.account.status === "active",
      account:
        choice._tag === "chosen"
          ? { id: choice.account.id, name: choice.account.name, status: choice.account.status }
          : null,
      selection: choice._tag,
    };
  };
  const claude = selected("claude");
  const codex = selected("codex");
  const providers = [
    claude,
    codex,
    { provider: "pi", connected: codex.connected, profileSaved: profile.profile !== null },
  ];
  return readinessResult(
    { providers },
    providers.map((p) => ({
      id: p.provider,
      state: p.connected ? "ok" : "todo",
      detail: p.connected
        ? "A selected login is connected."
        : "No active selected login was observed.",
      fix: p.connected ? null : `mend connect ${p.provider === "pi" ? "codex" : p.provider} --json`,
    })),
  );
};

/** Upload a credential with no provider subprocess or terminal prompt in JSON mode. */
export const connectJson = async (
  api: ApiCall,
  args: ReadonlyArray<string>,
  readCredential: (provider: "claude" | "codex" | "github") => string | null,
): Promise<CommandResult<unknown>> => {
  const [provider, ...flags] = args;
  if (provider === "status") return connectStatusJson(api);
  if (provider === "pi") {
    if (flags.includes("--remove"))
      return {
        status: "done",
        data: await api<{ readonly removed: boolean }>("DELETE", "/me/pi-profile"),
      };
    const scan = scanPiProfile(takeFlagValue(flags, "--dir") ?? piAgentDir());
    if ("error" in scan)
      return usage("The pi profile could not be read.", "Pass --dir <pi-agent-directory>.");
    const issue = validatePiProfile(scan.files);
    if (issue !== null) return usage(issue, "Fix the pi profile and retry mend connect pi --json.");
    if (flags.includes("--dry-run"))
      return { status: "done", data: { files: scan.files.map((f) => f.path), sent: false } };
    const saved = await api<{
      readonly profile: { readonly revision: number };
      readonly changed: boolean;
    }>("PUT", "/me/pi-profile", { files: scan.files });
    return {
      status: "done",
      data: { provider, revision: saved.profile.revision, changed: saved.changed },
    };
  }
  if (provider !== "claude" && provider !== "codex" && provider !== "github")
    return usage(
      "Choose a provider.",
      "Run mend connect <claude|codex|github|pi> --json or mend connect status --json.",
    );
  const apiKey = flags.includes("--api-key");
  if (apiKey && provider === "github")
    return usage(
      "GitHub takes a token, not an API key.",
      "Pipe gh auth token into mend connect github --from-stdin --json.",
    );
  const endpoint = endpointOption(flags);
  if (endpoint.kind === "refused")
    return usage(
      endpoint.reason,
      `Pass --api-key --endpoint <url> to mend connect ${provider} --json, with an absolute http or https URL.`,
    );
  if (flags.includes("--remove")) {
    const identity = await api<{ readonly accounts: ReadonlyArray<Account> }>("GET", "/me/sealant");
    const at = flags.indexOf("--remove");
    const name = flags[at + 1];
    const chosen = loginChoiceOf(identity.accounts, provider);
    const account = apiKey
      ? identity.accounts.find(
          (a) => a.provider === provider && a.status !== "archived" && a.login?.kind === "api-key",
        )
      : name !== undefined && !name.startsWith("--")
        ? identity.accounts.find(
            (a) => a.provider === provider && a.name === name && a.status !== "archived",
          )
        : chosen._tag === "chosen"
          ? chosen.account
          : null;
    if (account == null)
      return needsInput(
        "No single connected account was selected.",
        `Pass --remove <name> to mend connect ${provider} --json.`,
      );
    await api("DELETE", `/me/sealant/accounts/${encodeURIComponent(account.id)}`);
    return { status: "done", data: { provider, disconnected: true, accountId: account.id } };
  }
  if (
    ["--from-stdin", "--api-key", "--use-my-login"].filter((flag) => flags.includes(flag)).length >
    1
  )
    return usage(
      "Choose one credential source.",
      "Pass just one of --api-key, --from-stdin or --use-my-login.",
    );
  let loginSecret: string | null = null;
  if (
    (provider === "claude" || provider === "codex") &&
    !flags.some((flag) => ["--from-stdin", "--api-key", "--use-my-login"].includes(flag))
  ) {
    const timeout = parseDuration(takeFlagValue(flags, "--timeout") ?? "10m");
    if (timeout === null || timeout <= 0)
      return usage("Invalid provider login timeout.", "Pass --timeout 10m.");
    const grant = await providerLogin({
      provider,
      parent: path.join(
        process.env["XDG_CONFIG_HOME"] ??
          path.join(process.env["HOME"] ?? process.cwd(), ".config"),
        "mend",
      ),
      timeoutMs: timeout,
      personalSecret: readCredential(provider),
    });
    if (grant.kind === "result") return grant.result;
    loginSecret = grant.secret;
  }
  if (
    loginSecret === null &&
    !flags.includes("--from-stdin") &&
    !flags.includes("--api-key") &&
    !flags.includes("--use-my-login")
  )
    return needsInput(
      "This provider needs a browser login or an explicit credential source.",
      `Pass --from-stdin to mend connect ${provider} --json, or explicitly pass --use-my-login.`,
    );
  const secret =
    loginSecret ??
    (flags.includes("--from-stdin") || flags.includes("--api-key")
      ? fs.readFileSync(0, "utf8").trim()
      : readCredential(provider));
  if (secret === null || secret === "")
    return needsInput(
      "No provider credential was supplied.",
      `Pipe the credential into mend connect ${provider} --from-stdin --json.`,
    );
  const narrowed = narrowCredential(provider, secret);
  const account = await api<Account>("POST", "/me/sealant/accounts", {
    provider,
    secret: narrowed.secret,
    ...(apiKey ? { login: "api-key" } : {}),
    ...(endpoint.kind === "url" ? { endpoint: endpoint.url } : {}),
    ...(flags.includes("--default") ? { makeDefault: true } : {}),
  });
  return {
    status: "done",
    data: {
      provider,
      account: {
        id: account.id,
        name: account.name,
        status: account.status,
        ...(account.login === undefined ? {} : { login: account.login }),
      },
    },
  };
};

/** Ask the server to observe this project's own read and push transports. */
export const gitCheckCommand = async (
  api: ApiCall,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const explicit = takeFlagValue(args, "--project");
  const project = await resolveOnboardingProject(api, explicit);
  if (project === null && explicit !== null)
    return {
      status: "usage",
      error: {
        code: "project_not_found",
        message: `No adopted project has the id or name "${explicit}".`,
        fix: "Run mend projects and choose an existing project, or adopt the repository first.",
      },
    };
  if (project === null)
    return needsInput(
      "No adopted project matched this checkout.",
      "Pass --project <id-or-name> or run mend adopt --json in the repository.",
    );
  const report = await api<{
    readonly read: { readonly state: "ok" | "failed"; readonly detail: string };
    readonly push: { readonly state: "ok" | "failed"; readonly detail: string };
    readonly observedAt: string;
  }>("POST", `/projects/${encodeURIComponent(project.id)}/git/check`);
  const key =
    report.push.state === "ok"
      ? null
      : await api<{ readonly publicKey: string | null; readonly fingerprint: string | null }>(
          "GET",
          "/keys/git",
        );
  const items = ["read", "push"].map((id) => {
    const observation = id === "read" ? report.read : report.push;
    return {
      id,
      ...observation,
      fix:
        observation.state === "ok"
          ? null
          : /could not resolve|name resolution|resolve hostname/i.test(observation.detail)
            ? "Check DNS on the Mend server, then run mend git check --json again."
            : /timed? out|timeout|connection refused|connection reset|network is unreachable/i.test(
                  observation.detail,
                )
              ? "Check the network route from the Mend server to the Git host and retry after the connection or timeout is resolved."
              : /publickey|authentication failed|credential|not authorized|access denied|repository not found/i.test(
                    observation.detail,
                  )
                ? "Check the origin URL and authorization. For SSH, ask the person before adding Mend's public deploy key with the required access; then rerun the check."
                : "Read the transport's reason, check the origin URL and server Git configuration, then run mend git check --json again.",
    };
  });
  return readinessResult(
    {
      project: { id: project.id, name: project.name },
      ...report,
      deployKey: key === null ? null : { publicKey: key.publicKey, fingerprint: key.fingerprint },
    },
    items,
  );
};
