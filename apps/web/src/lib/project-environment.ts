/**
 * Settings → a project → Variables and secrets (route PR 55, Doop "Settings · Project ·
 * checkout-api · Variables and secrets"): the checks a variable or secret passes before it is sent,
 * in the words the server uses, and the sentences the page says about what was saved. Pure, so each
 * is tested without a server. A secret's value never passes through anything here but the check.
 *
 * Variables and secrets belong to one project: nothing in the organization or on the server
 * supplies them (docs/adr/0025).
 */

import {
  formatProjectEnvironmentIssue,
  validateProjectEnvironmentName,
  validateProjectEnvironmentValue,
  validateProjectSecretName,
  validateProjectSecretValue,
} from "@mend/domain/workbench";

import { dayOf } from "./organization.ts";

/** One reason a name or value won't be saved, as the server's `EnvironmentRejected` gives it. */
export interface EnvironmentIssue {
  readonly field: "name" | "value" | null;
  readonly rule: string;
  readonly message: string;
}

/**
 * A variable's checks, the same policy the server applies again, run before the request so a bad
 * name never goes out. A secret-looking name is refused here with the reason (it belongs in
 * Secrets).
 */
export const clientIssues = (input: {
  readonly name: string;
  readonly value: string;
}): ReadonlyArray<EnvironmentIssue> => {
  const issues: Array<EnvironmentIssue> = [];
  const nameIssue = validateProjectEnvironmentName(input.name);
  if (nameIssue !== null) {
    issues.push({
      field: "name",
      rule: nameIssue.rule,
      message: formatProjectEnvironmentIssue(nameIssue),
    });
  }
  const valueIssue = validateProjectEnvironmentValue(input.value);
  if (valueIssue !== null) {
    issues.push({
      field: "value",
      rule: valueIssue.rule,
      message: formatProjectEnvironmentIssue(valueIssue),
    });
  }
  return issues;
};

/**
 * A secret's checks: secret-shaped names are welcome, platform and agent-login names are not.
 * `value: null` checks the name alone.
 */
export const clientSecretIssues = (input: {
  readonly name: string;
  readonly value: string | null;
}): ReadonlyArray<EnvironmentIssue> => {
  const issues: Array<EnvironmentIssue> = [];
  const nameIssue = validateProjectSecretName(input.name);
  if (nameIssue !== null) {
    issues.push({
      field: "name",
      rule: nameIssue.rule,
      message: formatProjectEnvironmentIssue(nameIssue),
    });
  }
  if (input.value !== null) {
    const valueIssue = validateProjectSecretValue(input.value);
    if (valueIssue !== null) {
      issues.push({
        field: "value",
        rule: valueIssue.rule,
        message: formatProjectEnvironmentIssue(valueIssue),
      });
    }
  }
  return issues;
};

/** The issues that belong beside one field, or (with null) under the whole form. */
export const issuesFor = (
  issues: ReadonlyArray<EnvironmentIssue>,
  field: "name" | "value" | null,
): ReadonlyArray<EnvironmentIssue> => issues.filter((issue) => issue.field === field);

/**
 * When a secret was last set, beside its name. The server keeps when, not who, so the frames'
 * "Set by Ada Lovelace on 2 Nov" reads "Set on 2 November".
 */
export const secretSetLine = (updatedAt: Date, now: Date = new Date()): string =>
  `Set on ${dayOf(updatedAt, now)}`;

/** What a write the server answered with a stale revision says: someone changed it meanwhile. */
export const staleWords = (name: string): string =>
  `Someone changed ${name} while you were editing. Close this and open it again to see what it is now.`;

/** The load endpoint's per-name report, as the import dialog says it. */
export interface LoadReport {
  readonly loaded: ReadonlyArray<{
    readonly name: string;
    readonly lane: "configuration" | "secret";
    readonly action: "created" | "updated" | "moved";
  }>;
  readonly rejected: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  readonly malformedLines: ReadonlyArray<number>;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Added 3 variables and 2 secrets." with what was refused, for the toast after an import. */
export const loadSummary = (report: LoadReport): string => {
  const variables = report.loaded.filter((entry) => entry.lane === "configuration").length;
  const secrets = report.loaded.filter((entry) => entry.lane === "secret").length;
  const parts = [
    variables === 0 ? null : count(variables, "variable", "variables"),
    secrets === 0 ? null : count(secrets, "secret", "secrets"),
  ].filter((part) => part !== null);
  const saved = parts.length === 0 ? "Nothing was saved." : `Saved ${parts.join(" and ")}.`;
  const refused =
    report.rejected.length === 0
      ? ""
      : ` ${count(report.rejected.length, "name was", "names were")} refused.`;
  return `${saved}${refused}`;
};
