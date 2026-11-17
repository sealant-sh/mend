import { ProjectEnvironmentVariableId } from "@mend/domain";
import { storedSecretNameRefusal } from "@mend/domain/workbench";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useReducer, type KeyboardEvent } from "react";

import { Button } from "#/components/kit/button";
import { TextInput } from "#/components/kit/field";
import { FoldSection } from "#/components/kit/section";
import { DataTable } from "#/components/kit/table";
import {
  createProjectSecret,
  removeProjectSecret,
  updateProjectSecret,
  type ProjectSecretView,
  type ProjectSecretWriteResult,
} from "#/lib/project-environment";
import {
  clientSecretIssues,
  initialProjectEnvironmentForm,
  issuesFor,
  projectEnvironmentFormReducer,
} from "#/lib/project-environment-form";
import { useTRPC } from "#/lib/trpc";

import { ConfirmRemove } from "./secrets-remove";
import { countWords, namesSummary } from "./secrets-variables";

const mono = "font-mono text-[12px] text-ink-2";

type Editor = ReturnType<typeof projectEnvironmentFormReducer>;
type EditorDispatch = (action: Parameters<typeof projectEnvironmentFormReducer>[1]) => void;

/**
 * Secrets: API keys, database URLs, anything a session needs that must not be stored in the
 * clear. Sealed with this machine's key, never returned by any response, handed to the platform's
 * transient secret channel at launch and masked in recorded output. A value is set once and can
 * only be replaced, never read back. Folded by default: the names are all it can show.
 */
export function StoredSecretsSection({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useSuspenseQuery(trpc.environment.secrets.queryOptions({ projectId })).data;
  const [form, dispatch] = useReducer(projectEnvironmentFormReducer, initialProjectEnvironmentForm);
  const refresh = () =>
    queryClient.invalidateQueries(trpc.environment.secrets.queryFilter({ projectId }));

  const save = useMutation({
    mutationFn: (write: { run: () => Promise<ProjectSecretWriteResult>; notice: string }) =>
      write.run(),
    onMutate: () => dispatch({ type: "save-started" }),
    onSuccess: async (outcome, write) => {
      if (outcome.ok) {
        dispatch({ type: "save-succeeded", notice: write.notice });
        await refresh();
        return;
      }
      if (outcome.kind === "rejected") dispatch({ type: "save-rejected", issues: outcome.issues });
      else dispatch({ type: "save-conflicted" });
    },
    onError: (error) => dispatch({ type: "save-failed", message: error.message }),
  });

  const submit = () => {
    const editing = form.editing;
    if (editing === null || form.phase === "saving") return;
    // On a replace, an empty value keeps the stored one: it cannot be shown to be typed again.
    const replacing = editing.kind === "create" || form.value !== "";
    const found = clientSecretIssues({ name: form.name, value: replacing ? form.value : null });
    if (found.length > 0) {
      dispatch({ type: "save-rejected", issues: found });
      return;
    }
    if (editing.kind === "create") {
      save.mutate({
        run: () => createProjectSecret(projectId, { name: form.name, value: form.value }),
        notice: `Saved secret ${form.name}.`,
      });
      return;
    }
    save.mutate({
      run: () =>
        updateProjectSecret(projectId, editing.variableId, {
          name: form.name,
          value: replacing ? form.value : null,
          expectedRevision: editing.expectedRevision,
        }),
      notice: replacing
        ? `Replaced secret ${form.name}.`
        : editing.originalName === form.name
          ? `Saved secret ${form.name}.`
          : `Renamed secret ${editing.originalName} to ${form.name}.`,
    });
  };

  const editingId = form.editing?.kind === "edit" ? form.editing.variableId : null;
  const names = snapshot.secrets.map((secret) => secret.name);
  const rows = snapshot.secrets.map((secret) =>
    editingId === secret.id
      ? { key: secret.id, cells: secretEditorCells(form, dispatch, submit) }
      : {
          key: secret.id,
          cells: [
            <span key="name" className="grid gap-0.5">
              <span className={`${mono} break-all`}>{secret.name}</span>
              {storedSecretNameRefusal(secret.name) === null ? null : (
                <span className="text-[12px] text-warning">
                  {storedSecretNameRefusal(secret.name)}
                </span>
              )}
            </span>,
            <span key="kept" className="font-mono text-[12px] text-muted-foreground">
              value set · {new Date(secret.updatedAt).toLocaleString()}
            </span>,
            <SecretActions
              key="actions"
              projectId={projectId}
              secret={secret}
              disabled={form.editing !== null}
              onReplace={() =>
                dispatch({
                  type: "edit-opened",
                  // The shared editor holds a variable-shaped row: a secret has no value to give,
                  // and its id rides in the variable-id slot back to updateProjectSecret.
                  variable: {
                    id: ProjectEnvironmentVariableId.make(secret.id),
                    projectId: secret.projectId,
                    name: secret.name,
                    value: "",
                    revision: secret.revision,
                    createdAt: secret.createdAt,
                    updatedAt: secret.updatedAt,
                  },
                })
              }
              onRemoved={async () => {
                dispatch({ type: "save-succeeded", notice: `Removed secret ${secret.name}.` });
                await refresh();
              }}
            />,
          ],
        },
  );

  return (
    <FoldSection
      title="Secrets"
      count={countWords(names.length, "secret")}
      why="Never shown again after you save them. Encrypted on this machine; the platform never keeps them and masks them in recorded output."
      summary={namesSummary(names, "none yet")}
      defaultOpen={false}
    >
      <div className="mb-2 flex items-center gap-2">
        <p role="status" className="flex-1 font-mono text-[11.5px] text-success">
          {form.notice}
        </p>
        <Button
          size="sm"
          disabled={form.editing !== null}
          onClick={() => dispatch({ type: "create-opened" })}
        >
          Add a secret
        </Button>
      </div>
      <DataTable
        label="Secrets"
        columns={[
          { head: "Name", width: "1fr" },
          { head: "Value", width: "1.2fr" },
          { head: "", width: "minmax(150px,auto)", align: "end" },
        ]}
        empty={
          <>
            No secrets yet. Add one here, or from a terminal with{" "}
            <span className="font-mono">mend env load</span>.
          </>
        }
        rows={
          form.editing?.kind === "create"
            ? [{ key: "new", cells: secretEditorCells(form, dispatch, submit) }, ...rows]
            : rows
        }
      />
    </FoldSection>
  );
}

/** A secret's row while it is added or replaced: its name, a new value, and Save or Cancel. */
const secretEditorCells = (form: Editor, dispatch: EditorDispatch, submit: () => void) => {
  const saving = form.phase === "saving";
  const replacing = form.editing?.kind === "edit";
  const nameIssues = issuesFor(form.issues, "name");
  const valueIssues = issuesFor(form.issues, "value");
  const messages = [
    ...valueIssues.map((issue) => issue.message),
    ...issuesFor(form.issues, null).map((issue) => issue.message),
    ...(form.conflict
      ? ["This secret changed elsewhere since you opened it. Your draft is kept; cancel to reload."]
      : []),
    ...(form.error === null ? [] : [form.error]),
  ];
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape") dispatch({ type: "closed" });
  };
  return [
    <span key="name" className="grid gap-1">
      <TextInput
        aria-label="Secret name"
        autoFocus
        value={form.name}
        disabled={saving}
        placeholder="STRIPE_API_KEY"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={nameIssues.length > 0 || undefined}
        onKeyDown={onKeyDown}
        onChange={(event) => dispatch({ type: "name-changed", name: event.target.value })}
      />
      {nameIssues.map((issue) => (
        <span key={issue.message} role="alert" className="text-[12px] text-danger">
          {issue.message}
        </span>
      ))}
    </span>,
    <span key="value" className="grid gap-1">
      <TextInput
        type="password"
        aria-label={replacing ? "New value" : "Value"}
        value={form.value}
        disabled={saving}
        placeholder={replacing ? "empty keeps the stored value" : ""}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={valueIssues.length > 0 || undefined}
        onKeyDown={onKeyDown}
        onChange={(event) => dispatch({ type: "value-changed", value: event.target.value })}
      />
      {messages.map((message) => (
        <span key={message} role="alert" className="text-[12px] text-danger">
          {message}
        </span>
      ))}
    </span>,
    <span key="actions" className="inline-flex gap-1.5">
      <Button
        size="sm"
        variant="ghost"
        disabled={saving}
        onClick={() => dispatch({ type: "closed" })}
      >
        Cancel
      </Button>
      <Button size="sm" variant="primary" disabled={saving} onClick={submit}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </span>,
  ];
};

function SecretActions({
  projectId,
  secret,
  disabled,
  onReplace,
  onRemoved,
}: {
  readonly projectId: string;
  readonly secret: ProjectSecretView;
  readonly disabled: boolean;
  readonly onReplace: () => void;
  readonly onRemoved: () => Promise<void>;
}) {
  return (
    <span className="inline-flex items-start gap-0.5">
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Replace ${secret.name}`}
        disabled={disabled}
        onClick={onReplace}
      >
        Replace
      </Button>
      <ConfirmRemove
        label={secret.name}
        disabled={disabled}
        onRemove={async () => {
          const outcome = await removeProjectSecret(projectId, secret.id, secret.revision);
          if (!outcome.ok)
            throw new Error(
              outcome.kind === "stale"
                ? "This secret changed elsewhere. Reload before removing it."
                : "The remove failed.",
            );
          await onRemoved();
        }}
      />
    </span>
  );
}
