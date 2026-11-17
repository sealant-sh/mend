import {
  formatProjectEnvironmentIssue,
  validateProjectEnvironmentName,
  validateProjectEnvironmentValue,
  validateProjectSecretName,
  validateProjectSecretValue,
} from "@mend/domain/workbench";

import type { EnvironmentIssueView, ProjectEnvironmentVariableView } from "./project-environment";

/**
 * Pure state for the Configuration panel's one editor (add or edit — one open at a time). A
 * rejected or conflicted save keeps the draft intact; the reducer is the whole policy so it tests
 * without a DOM.
 */
export interface ProjectEnvironmentFormState {
  readonly editing:
    | { readonly kind: "create" }
    | {
        readonly kind: "edit";
        readonly variableId: string;
        readonly expectedRevision: number;
        readonly originalName: string;
      }
    | null;
  readonly name: string;
  readonly value: string;
  readonly phase: "idle" | "saving";
  /** Rejections from the server (or the identical client-side pre-check). */
  readonly issues: ReadonlyArray<EnvironmentIssueView>;
  /** Set when the row moved underneath the caller; the draft survives. */
  readonly conflict: boolean;
  /** Transport/unexpected failure line. */
  readonly error: string | null;
  /** Live-region status ("Saved APP_MODE."), cleared when an editor opens. */
  readonly notice: string | null;
}

export type ProjectEnvironmentFormAction =
  | { readonly type: "create-opened" }
  | { readonly type: "edit-opened"; readonly variable: ProjectEnvironmentVariableView }
  | { readonly type: "closed" }
  | { readonly type: "name-changed"; readonly name: string }
  | { readonly type: "value-changed"; readonly value: string }
  | { readonly type: "save-started" }
  | { readonly type: "save-rejected"; readonly issues: ReadonlyArray<EnvironmentIssueView> }
  | { readonly type: "save-conflicted" }
  | { readonly type: "save-failed"; readonly message: string }
  | { readonly type: "save-succeeded"; readonly notice: string };

export const initialProjectEnvironmentForm: ProjectEnvironmentFormState = {
  editing: null,
  name: "",
  value: "",
  phase: "idle",
  issues: [],
  conflict: false,
  error: null,
  notice: null,
};

export const projectEnvironmentFormReducer = (
  state: ProjectEnvironmentFormState,
  action: ProjectEnvironmentFormAction,
): ProjectEnvironmentFormState => {
  switch (action.type) {
    case "create-opened":
      return {
        ...initialProjectEnvironmentForm,
        editing: { kind: "create" },
      };
    case "edit-opened":
      return {
        ...initialProjectEnvironmentForm,
        editing: {
          kind: "edit",
          variableId: action.variable.id,
          expectedRevision: action.variable.revision,
          originalName: action.variable.name,
        },
        name: action.variable.name,
        value: action.variable.value,
      };
    case "closed":
      return { ...initialProjectEnvironmentForm, notice: state.notice };
    case "name-changed":
      // Typing clears field feedback but not an open conflict — that needs an explicit reload.
      return { ...state, name: action.name, issues: [], error: null };
    case "value-changed":
      return { ...state, value: action.value, issues: [], error: null };
    case "save-started":
      return { ...state, phase: "saving", issues: [], conflict: false, error: null, notice: null };
    case "save-rejected":
      return { ...state, phase: "idle", issues: action.issues };
    case "save-conflicted":
      return { ...state, phase: "idle", conflict: true };
    case "save-failed":
      return { ...state, phase: "idle", error: action.message };
    case "save-succeeded":
      return { ...initialProjectEnvironmentForm, notice: action.notice };
  }
};

/**
 * The exact policy the server re-applies, run before the request so a bad name never round-trips.
 * Wording is shared with the domain module, so client and server rejections read identically.
 */
export const clientIssues = (input: {
  readonly name: string;
  readonly value: string;
}): ReadonlyArray<EnvironmentIssueView> => {
  const issues: Array<EnvironmentIssueView> = [];
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

export const issuesFor = (
  issues: ReadonlyArray<EnvironmentIssueView>,
  field: "name" | "value" | null,
): ReadonlyArray<EnvironmentIssueView> => issues.filter((issue) => issue.field === field);

/**
 * The secret lane's pre-check: secret-shaped names are welcome, platform/account names are not;
 * `value: null` means "keep the stored value" on an edit and skips the value check.
 */
export const clientSecretIssues = (input: {
  readonly name: string;
  readonly value: string | null;
}): ReadonlyArray<EnvironmentIssueView> => {
  const issues: Array<EnvironmentIssueView> = [];
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
