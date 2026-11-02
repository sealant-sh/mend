/** The observed result of restarting one Service after a resource switch. */
export type ResourceServiceRestart =
  | { readonly name: string; readonly kind: "restarted" }
  | { readonly name: string; readonly kind: "failed"; readonly message: string };

/** Names whose values changed, retaining resource env order, including removals. */
export const changedResourceEnvNames = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  prefix?: string,
): ReadonlyArray<string> => {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const suffixes = ["URL", "HOST", "PORT", "USER", "PASSWORD", "DATABASE"];
  const order = (name: string) => {
    const index = suffixes.findIndex((suffix) =>
      prefix === undefined ? name.endsWith(`_${suffix}`) : name === `${prefix}${suffix}`,
    );
    return index === -1 ? suffixes.length : index;
  };
  return names
    .filter((name) => before[name] !== after[name])
    .toSorted((a, b) => order(a) - order(b));
};

/** Tell running processes what a switch changed, without printing resource values. */
export const resourceSwitchMessage = (input: {
  readonly name: string;
  readonly from: "project" | "worktree" | "off";
  readonly to: "project" | "worktree" | "off";
  readonly changed: ReadonlyArray<string>;
  readonly services: ReadonlyArray<ResourceServiceRestart>;
}): string => {
  const sentences = [
    `@${input.name} switched from ${input.from} to ${input.to}.`,
    ...(input.changed.length === 0
      ? [
          `No MEND_* value changed: the same names now reach ${input.to === "worktree" ? "this worktree's own container" : "the project's container"}.`,
        ]
      : [
          `Changed: ${input.changed.join(", ")}.`,
          "Your already-running processes, including your own shell, still have the old values.",
          "Run mend resource env to print the current values, or restart the process to receive them.",
          "Printing values does not update your shell.",
        ]),
  ];
  const restarted = input.services.filter((service) => service.kind === "restarted");
  const failed = input.services.filter((service) => service.kind === "failed");
  if (restarted.length > 0)
    sentences.push(
      failed.length === 0
        ? "Mend restarted this worktree's Services with the current values."
        : `Mend restarted ${restarted.map((service) => service.name).join(", ")} with the current values.`,
    );
  for (const service of failed)
    sentences.push(`${service.name} did not restart: ${service.message}.`);
  return sentences.join(" ");
};
