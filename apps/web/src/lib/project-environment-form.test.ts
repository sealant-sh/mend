import { ProjectEnvironmentVariableId, ProjectId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { ProjectEnvironmentVariableView } from "./project-environment";
import {
  clientIssues,
  clientSecretIssues,
  initialProjectEnvironmentForm,
  issuesFor,
  projectEnvironmentFormReducer,
  type ProjectEnvironmentFormState,
} from "./project-environment-form";

const variable: ProjectEnvironmentVariableView = {
  id: ProjectEnvironmentVariableId.make("var-1"),
  projectId: ProjectId.make("proj-1"),
  name: "APP_MODE",
  value: "review",
  revision: 3,
  createdAt: new Date("2026-08-17T00:00:00Z"),
  updatedAt: new Date("2026-08-17T00:00:00Z"),
};

const reduce = (
  state: ProjectEnvironmentFormState,
  ...actions: ReadonlyArray<Parameters<typeof projectEnvironmentFormReducer>[1]>
) => actions.reduce(projectEnvironmentFormReducer, state);

describe("projectEnvironmentFormReducer", () => {
  it("opens the editor pre-filled for edit, empty for create", () => {
    const editing = reduce(initialProjectEnvironmentForm, { type: "edit-opened", variable });
    expect(editing.name).toBe("APP_MODE");
    expect(editing.value).toBe("review");
    expect(editing.editing).toEqual({
      kind: "edit",
      variableId: "var-1",
      expectedRevision: 3,
      originalName: "APP_MODE",
    });

    const creating = reduce(initialProjectEnvironmentForm, { type: "create-opened" });
    expect(creating.name).toBe("");
    expect(creating.editing).toEqual({ kind: "create" });
  });

  it("keeps the draft intact through a rejection", () => {
    const state = reduce(
      initialProjectEnvironmentForm,
      { type: "create-opened" },
      { type: "name-changed", name: "DB_HOST" },
      { type: "value-changed", value: "localhost" },
      { type: "save-started" },
      {
        type: "save-rejected",
        issues: [{ field: "name", rule: "duplicate-name", message: "Already exists." }],
      },
    );
    expect(state.phase).toBe("idle");
    expect(state.name).toBe("DB_HOST");
    expect(state.value).toBe("localhost");
    expect(state.issues).toHaveLength(1);
  });

  it("keeps the draft intact through a stale-write conflict", () => {
    const state = reduce(
      initialProjectEnvironmentForm,
      { type: "edit-opened", variable },
      { type: "value-changed", value: "changed" },
      { type: "save-started" },
      { type: "save-conflicted" },
    );
    expect(state.conflict).toBe(true);
    expect(state.value).toBe("changed");
    expect(state.editing?.kind).toBe("edit");
  });

  it("typing clears field issues but not an open conflict", () => {
    const rejected = reduce(
      initialProjectEnvironmentForm,
      { type: "edit-opened", variable },
      { type: "save-conflicted" },
      {
        type: "save-rejected",
        issues: [{ field: "name", rule: "name-grammar", message: "Bad name." }],
      },
      { type: "name-changed", name: "BETTER_NAME" },
    );
    expect(rejected.issues).toEqual([]);
    expect(rejected.conflict).toBe(true);
  });

  it("success resets everything except the announced notice", () => {
    const state = reduce(
      initialProjectEnvironmentForm,
      { type: "edit-opened", variable },
      { type: "save-started" },
      { type: "save-succeeded", notice: "Saved APP_MODE." },
    );
    expect(state).toEqual({ ...initialProjectEnvironmentForm, notice: "Saved APP_MODE." });
  });

  it("closing keeps the last notice so the live region does not blank out", () => {
    const state = reduce(
      initialProjectEnvironmentForm,
      { type: "edit-opened", variable },
      { type: "save-succeeded", notice: "Saved APP_MODE." },
      { type: "create-opened" },
      { type: "closed" },
    );
    // create-opened clears the notice (a fresh editor announces nothing stale)…
    expect(state.notice).toBeNull();
    const kept = reduce(
      initialProjectEnvironmentForm,
      { type: "save-succeeded", notice: "Removed APP_MODE." },
      { type: "closed" },
    );
    // …but a bare close after a success keeps it.
    expect(kept.notice).toBe("Removed APP_MODE.");
  });
});

describe("clientIssues", () => {
  it("mirrors the server policy with the same wording, values never included", () => {
    const issues = clientIssues({ name: "DB_PASSWORD", value: "hunter2" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("name");
    expect(issues[0]?.rule).toBe("name-reserved");
    expect(JSON.stringify(issues)).not.toContain("hunter2");
  });

  it("accepts an ordinary pair, including an empty value", () => {
    expect(clientIssues({ name: "APP_MODE", value: "" })).toEqual([]);
  });

  it("splits issues by field for the two inputs", () => {
    const issues = clientIssues({ name: "BAD NAME", value: "x".repeat(5000) });
    expect(issuesFor(issues, "name")).toHaveLength(1);
    expect(issuesFor(issues, "value")).toHaveLength(1);
    expect(issuesFor(issues, null)).toHaveLength(0);
  });
});

describe("clientSecretIssues", () => {
  const codexWords =
    "OPENAI_API_KEY is a Codex login. Connect it in Settings → Connected accounts, or with mend connect codex; a project secret never decides which login a session spends.";

  it("refuses a provider login name, for a new secret or a replaced value, pointing to Connected accounts", () => {
    expect(clientSecretIssues({ name: "OPENAI_API_KEY", value: "fake" })).toEqual([
      { field: "name", rule: "name-provider-login", message: codexWords },
    ]);
    expect(clientSecretIssues({ name: "OPENAI_API_KEY", value: null })).toEqual([
      { field: "name", rule: "name-provider-login", message: codexWords },
    ]);
  });

  it("lets a stored provider login be renamed away", () => {
    expect(clientSecretIssues({ name: "LEGACY_OPENAI_KEY", value: null })).toEqual([]);
  });
});
