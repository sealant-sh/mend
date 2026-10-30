export type ProjectRetentionCommand =
  | { readonly command: "removed"; readonly json: boolean }
  | { readonly command: "rm"; readonly id: string; readonly json: boolean }
  | {
      readonly command: "restore";
      readonly id: string;
      readonly name?: string;
      readonly json: boolean;
    }
  | {
      readonly command: "purge";
      readonly id: string;
      readonly confirm: string;
      readonly json: boolean;
    }
  | { readonly error: string };

export const parseProjectRetentionArgs = (args: ReadonlyArray<string>): ProjectRetentionCommand => {
  const [command, ...rest] = args;
  if (command !== "removed" && command !== "rm" && command !== "restore" && command !== "purge")
    return { error: "Expected rm, removed, restore or purge." };
  let id: string | undefined;
  let name: string | undefined;
  let confirm: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (
      (arg === "--name" && command === "restore") ||
      (arg === "--confirm" && command === "purge")
    ) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--"))
        return { error: `${arg} requires a value.` };
      if (arg === "--name") name = value;
      else confirm = value;
      continue;
    }
    if (!arg.startsWith("-") && id === undefined && command !== "removed") {
      id = arg;
      continue;
    }
    return { error: `Unknown argument ${arg}.` };
  }
  if (command === "removed") return { command, json };
  if (id === undefined) return { error: `${command} requires a project id.` };
  if (command === "purge")
    return confirm === undefined
      ? { error: "Purge requires --confirm <project-name>." }
      : { command, id, confirm, json };
  if (command === "restore") return { command, id, ...(name === undefined ? {} : { name }), json };
  return { command, id, json };
};
