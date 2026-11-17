import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useReducer, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "#/components/kit/button";
import { TextInput } from "#/components/kit/field";
import { Icon } from "#/components/kit/icons";
import { FoldSection } from "#/components/kit/section";
import { DataTable } from "#/components/kit/table";
import { composerReducer, initialComposer } from "#/lib/env-composer";
import {
  removeProjectEnvironmentVariable,
  updateProjectEnvironmentVariable,
  type ProjectEnvironmentVariableView,
  type ProjectEnvironmentWriteResult,
} from "#/lib/project-environment";
import {
  clientIssues,
  initialProjectEnvironmentForm,
  issuesFor,
  projectEnvironmentFormReducer,
} from "#/lib/project-environment-form";
import { useTRPC } from "#/lib/trpc";
import { copyText } from "#/lib/workbench-menus";

import { AddVariablesDialog } from "./secrets-composer";
import { ConfirmRemove } from "./secrets-remove";

const mono = "font-mono text-[12px] text-ink-2";

/** Plural words for a count: "5 variables", "1 variable". */
export const countWords = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "A · B · C · and 2 more": what a folded section names. */
export const namesSummary = (names: ReadonlyArray<string>, none: string): string =>
  names.length === 0
    ? none
    : names.length <= 3
      ? names.join(" · ")
      : `${names.slice(0, 3).join(" · ")} · and ${names.length - 3} more`;

/**
 * Variables: plain name and value pairs every process in this project's future workspaces gets,
 * the agent, shells, Services, setup and checks. Read back in the clear, so secret-looking names
 * are refused here with the server's own words and go to Secrets. Add several at once, or import
 * a `.env`, through the composer; edit one in its row.
 */
export function VariablesSection({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const environment = useSuspenseQuery(
    trpc.environment.environment.queryOptions({ projectId }),
  ).data;
  const [form, dispatch] = useReducer(projectEnvironmentFormReducer, initialProjectEnvironmentForm);
  const [composer, compose] = useReducer(composerReducer, initialComposer);
  const [composing, setComposing] = useState(false);
  const [filter, setFilter] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries(trpc.environment.environment.queryFilter({ projectId }));

  const save = useMutation({
    mutationFn: (write: { run: () => Promise<ProjectEnvironmentWriteResult>; notice: string }) =>
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
    if (form.editing?.kind !== "edit" || form.phase === "saving") return;
    const found = clientIssues({ name: form.name, value: form.value });
    if (found.length > 0) {
      dispatch({ type: "save-rejected", issues: found });
      return;
    }
    const editing = form.editing;
    save.mutate({
      run: () =>
        updateProjectEnvironmentVariable(projectId, editing.variableId, {
          name: form.name,
          value: form.value,
          expectedRevision: editing.expectedRevision,
        }),
      notice:
        editing.originalName === form.name
          ? `Saved ${form.name}.`
          : `Renamed ${editing.originalName} to ${form.name}.`,
    });
  };

  const importFile = (file: File | undefined) => {
    if (file === undefined) return;
    void file.text().then((text) => {
      compose({ type: "text-expanded", intoId: composer.rows.at(-1)?.id ?? null, text });
      setComposing(true);
      return undefined;
    });
  };

  const needle = filter.trim().toLowerCase();
  const variables = environment.variables.filter(
    (variable) =>
      needle === "" ||
      variable.name.toLowerCase().includes(needle) ||
      variable.value.toLowerCase().includes(needle),
  );
  const editingId = form.editing?.kind === "edit" ? form.editing.variableId : null;
  const names = environment.variables.map((variable) => variable.name);

  return (
    <FoldSection
      title="Variables"
      count={countWords(names.length, "variable")}
      why="Plain values every session in this project gets. Stored and shown in the clear; passwords and keys belong in Secrets."
      summary={namesSummary(names, "none yet")}
    >
      <div className="mb-2 flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] bg-secondary px-3 py-[7px] text-faint focus-within:ring-2 focus-within:ring-ring/30">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={filter}
            aria-label="Filter variables"
            placeholder="Filter variables"
            onChange={(event) => setFilter(event.target.value)}
            className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-foreground outline-none placeholder:text-faint"
          />
        </label>
        <Button size="sm" onClick={() => setComposing(true)}>
          Add variables
        </Button>
        <Button size="sm" onClick={() => fileInput.current?.click()}>
          Import .env
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".env,text/plain,.txt"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            importFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      <p role="status" className="mb-1 font-mono text-[11.5px] text-success empty:hidden">
        {form.notice}
      </p>
      <DataTable
        label="Variables"
        columns={[
          { head: "Name", width: "1fr" },
          { head: "Value", width: "1.5fr" },
          { head: "", width: "minmax(150px,auto)", align: "end" },
        ]}
        empty={
          needle === ""
            ? "No variables yet. Each one is set on the workspace at launch and inherited by everything Mend starts inside it."
            : `No variable matches ${filter.trim()}.`
        }
        rows={variables.map((variable) =>
          editingId === variable.id
            ? { key: variable.id, cells: editorCells(form, dispatch, submit) }
            : {
                key: variable.id,
                cells: [
                  <span key="name" className={`${mono} break-all`}>
                    {variable.name}
                  </span>,
                  <span key="value" className={`${mono} break-all whitespace-pre-wrap`}>
                    {variable.value === "" ? (
                      <span className="text-faint">(empty)</span>
                    ) : (
                      variable.value
                    )}
                  </span>,
                  <VariableActions
                    key="actions"
                    projectId={projectId}
                    variable={variable}
                    disabled={form.editing !== null}
                    onEdit={() => dispatch({ type: "edit-opened", variable })}
                    onRemoved={async () => {
                      dispatch({ type: "save-succeeded", notice: `Removed ${variable.name}.` });
                      await refresh();
                    }}
                  />,
                ],
              },
        )}
      />
      <p className="mt-3 text-[12.5px] text-muted-foreground">
        Docker Compose may use these for interpolation. Containers started by Compose or{" "}
        <span className="font-mono text-[12px]">docker run</span> get only what the Compose file or
        command passes.
      </p>
      <AddVariablesDialog
        projectId={projectId}
        open={composing}
        onOpenChange={setComposing}
        state={composer}
        dispatch={compose}
      />
    </FoldSection>
  );
}

type FormState = ReturnType<typeof projectEnvironmentFormReducer>;
type FormDispatch = (action: Parameters<typeof projectEnvironmentFormReducer>[1]) => void;

/** One variable's row, editable in place: its name, its value, and Save or Cancel. */
const editorCells = (form: FormState, dispatch: FormDispatch, submit: () => void) => {
  const saving = form.phase === "saving";
  const nameIssues = issuesFor(form.issues, "name");
  const valueIssues = issuesFor(form.issues, "value");
  const aggregate = [
    ...issuesFor(form.issues, null).map((issue) => issue.message),
    ...(form.conflict
      ? [
          "This variable changed elsewhere since you opened it. Your draft is kept; cancel to load the current value.",
        ]
      : []),
    ...(form.error === null ? [] : [form.error]),
  ];
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape") dispatch({ type: "closed" });
  };
  return [
    <span key="name" className="grid gap-1">
      <TextInput
        aria-label="Name"
        autoFocus
        value={form.name}
        disabled={saving}
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
        aria-label="Value"
        value={form.value}
        disabled={saving}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={valueIssues.length > 0 || undefined}
        onKeyDown={onKeyDown}
        onChange={(event) => dispatch({ type: "value-changed", value: event.target.value })}
      />
      {[...valueIssues.map((issue) => issue.message), ...aggregate].map((message) => (
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

function VariableActions({
  projectId,
  variable,
  disabled,
  onEdit,
  onRemoved,
}: {
  readonly projectId: string;
  readonly variable: ProjectEnvironmentVariableView;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onRemoved: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-start gap-0.5">
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Copy ${variable.name}`}
        disabled={disabled}
        onClick={() => {
          copyText(`${variable.name}=${variable.value}`);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Edit ${variable.name}`}
        disabled={disabled}
        onClick={onEdit}
      >
        Edit
      </Button>
      <ConfirmRemove
        label={variable.name}
        disabled={disabled}
        onRemove={async () => {
          const outcome = await removeProjectEnvironmentVariable(
            projectId,
            variable.id,
            variable.revision,
          );
          if (!outcome.ok)
            throw new Error(
              outcome.kind === "stale"
                ? "This variable changed elsewhere. Reload before removing it."
                : "The remove failed.",
            );
          await onRemoved();
        }}
      />
    </span>
  );
}
