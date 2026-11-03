import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ClipboardEvent } from "react";

import { Button } from "#/components/kit/button";
import { TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { SwitchRow } from "#/components/kit/switch";
import {
  composerSubmission,
  looksLikeDotenv,
  rowLane,
  serializeRows,
  type ComposerAction,
  type ComposerState,
} from "#/lib/env-composer";
import { loadProjectEnvironment, type EnvironmentLoadReportView } from "#/lib/project-environment";
import { useTRPC } from "#/lib/trpc";

/**
 * Add variables: Key and Value rows, "Add another", a Sensitive switch, and paste detection. A
 * whole `.env` pasted into any field, or imported from a file, becomes one row per key with its
 * comments dropped. Each row says where it will land: Variables in the clear, Secrets, or why it
 * is refused. Values stay hidden until shown. The rows live with the Variables section, so an
 * imported file opens the dialog already filled and a closed dialog keeps its draft.
 */
export function AddVariablesDialog({
  projectId,
  open,
  onOpenChange,
  state,
  dispatch,
}: {
  readonly projectId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly state: ComposerState;
  readonly dispatch: (action: ComposerAction) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [report, setReport] = useState<EnvironmentLoadReportView | null>(null);
  const submission = composerSubmission(state);
  const lanes = state.rows.map((row) => rowLane(row, state.allSecret));
  const anyValue = state.rows.some((row) => row.value !== "");
  const allRevealed = state.rows.filter((row) => row.value !== "").every((row) => row.revealed);
  const rejectedCount = lanes.filter((lane) => lane.kind === "rejected").length;
  const rejectedRows = rejectedCount === 1 ? "row" : `${rejectedCount} rows`;

  const save = useMutation({
    mutationFn: () =>
      loadProjectEnvironment(projectId, {
        contents: serializeRows(submission.postedRows),
        allSecret: state.allSecret,
        secretNames: [],
      }),
    onMutate: () => setReport(null),
    onSuccess: async (result) => {
      setReport(result);
      const loaded = new Set(result.loaded.map((entry) => entry.name));
      dispatch({
        type: "rows-cleared",
        ids: submission.postedRows.filter((row) => loaded.has(row.key)).map((row) => row.id),
      });
      await queryClient.invalidateQueries(trpc.environment.pathFilter());
    },
  });
  const saving = save.isPending;
  const canSave = !saving && submission.acceptedCount > 0;

  const onPaste = (rowId: number) => (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!looksLikeDotenv(text)) return;
    event.preventDefault();
    dispatch({ type: "text-expanded", intoId: rowId, text });
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      width={680}
      title="Add variables"
      description={
        <>
          One key per row. Paste a whole <span className="font-mono text-[12.5px]">.env</span> into
          any field and it becomes one row per key.
        </>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <SwitchRow
          label="Sensitive"
          detail="On, every row is stored as a secret: encrypted here, never readable again, only replaceable. Off, ordinary names become variables you can read back; secret-looking names still go to Secrets."
          checked={state.allSecret}
          disabled={saving}
          onCheckedChange={() => dispatch({ type: "all-secret-toggled" })}
        />
        <div className="grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto_auto] items-start gap-x-2 gap-y-1">
          <span className="font-sans text-[12.5px] font-medium text-ink-2">Key</span>
          <span className="flex items-baseline justify-between font-sans text-[12.5px] font-medium text-ink-2">
            Value
            {anyValue ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => dispatch({ type: "reveal-all-set", revealed: !allRevealed })}
              >
                {allRevealed ? "Hide all" : "Show all"}
              </Button>
            ) : null}
          </span>
          <span />
          <span />
          {state.rows.map((row, index) => {
            const lane = lanes[index] ?? { kind: "empty" as const };
            return (
              <div key={row.id} className="contents">
                <span className="grid gap-0.5">
                  <TextInput
                    value={row.key}
                    disabled={saving}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="CLIENT_ID"
                    aria-label={`Key ${index + 1}`}
                    aria-invalid={lane.kind === "rejected" || undefined}
                    onChange={(event) =>
                      dispatch({ type: "key-changed", id: row.id, key: event.target.value })
                    }
                    onPaste={onPaste(row.id)}
                  />
                  <span className="min-h-4 font-mono text-[11px] leading-4">
                    {lane.kind === "configuration" ? (
                      <span className="text-faint">→ variable · in the clear</span>
                    ) : lane.kind === "secret" ? (
                      <span className="text-faint">→ secret</span>
                    ) : lane.kind === "rejected" ? (
                      <span className="font-sans text-danger">{lane.reason}</span>
                    ) : null}
                  </span>
                </span>
                <TextInput
                  // Hidden until this row is shown: a pasted .env should not sit on screen.
                  type={row.revealed ? "text" : "password"}
                  value={row.value}
                  disabled={saving}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={`Value ${index + 1}`}
                  onChange={(event) =>
                    dispatch({ type: "value-changed", id: row.id, value: event.target.value })
                  }
                  onPaste={onPaste(row.id)}
                />
                <Button
                  size="sm"
                  disabled={saving || row.value === ""}
                  aria-label={`${row.revealed ? "Hide" : "Show"} value ${index + 1}`}
                  aria-pressed={row.revealed}
                  onClick={() => dispatch({ type: "reveal-toggled", id: row.id })}
                  className="mt-1"
                >
                  {row.revealed ? "Hide" : "Show"}
                </Button>
                <Button
                  size="sm"
                  disabled={saving}
                  aria-label={`Remove row ${index + 1}`}
                  onClick={() => dispatch({ type: "row-removed", id: row.id })}
                  className="mt-1"
                >
                  −
                </Button>
              </div>
            );
          })}
        </div>
        <div>
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => dispatch({ type: "row-added" })}
          >
            + Add another
          </Button>
        </div>
        <div aria-live="polite" className="grid gap-1 empty:hidden">
          {state.skippedLines === 0 ? null : (
            <p className="text-[12.5px] text-muted-foreground">
              Skipped {state.skippedLines} line{state.skippedLines === 1 ? "" : "s"} that were not{" "}
              <span className="font-mono">KEY=value</span>.
            </p>
          )}
          {rejectedCount === 0 ? null : (
            <p className="text-[12.5px] text-danger">
              {submission.acceptedCount === 0
                ? `Fix or remove the ${rejectedRows} marked above to save.`
                : `Save leaves the ${rejectedRows} marked above here and loads the rest.`}
            </p>
          )}
        </div>
        <p role="alert" className="font-mono text-[11.5px] text-danger empty:hidden">
          {save.isError ? `Nothing was saved: ${save.error.message}` : ""}
        </p>
        {report === null ? null : (
          <div role="status" className="border-t border-rule-faint pt-3">
            <p className="font-sans text-[12.5px] font-medium">
              Saved {report.loaded.length}
              {report.rejected.length === 0 ? "" : ` · refused ${report.rejected.length}`}
            </p>
            <ul className="mt-1 grid gap-0.5">
              {report.loaded.map((entry) => (
                <li key={`loaded-${entry.name}`} className="font-mono text-[12px] text-ink-2">
                  {entry.name}{" "}
                  <span className="text-faint">
                    · {entry.lane === "configuration" ? "variable · in the clear" : entry.lane} ·{" "}
                    {entry.action}
                  </span>
                </li>
              ))}
              {report.rejected.map((entry) => (
                <li key={`rejected-${entry.name}`} className="font-mono text-[12px] text-ink-2">
                  {entry.name} <span className="text-danger">· refused</span>{" "}
                  <span className="font-sans text-[12px] text-muted-foreground">
                    {entry.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex items-center justify-end gap-2.5">
          <Button variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>
            {report === null ? "Cancel" : "Done"}
          </Button>
          <Button type="submit" variant="primary" disabled={!canSave}>
            {saving
              ? "Saving…"
              : submission.acceptedCount > 1
                ? `Save ${submission.acceptedCount}`
                : "Save"}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
