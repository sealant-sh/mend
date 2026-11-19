import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { Switch } from "@mend/ui/components/ui/switch";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useId, useReducer, useState } from "react";

import {
  composerReducer,
  composerSubmission,
  initialComposer,
  rowLane,
  serializeRows,
} from "#/lib/env-composer";
import { usePhone } from "#/lib/phone";
import {
  clientIssues,
  clientSecretIssues,
  type EnvironmentIssue,
  issuesFor,
  loadSummary,
  staleWords,
} from "#/lib/project-environment";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";

/** What the page knows of a variable it edits or removes. */
export interface VariableRow {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly revision: number;
}

/** What the page knows of a secret: never its value. */
export interface SecretRow {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
}

/** A write's answer from the router: saved, refused with reasons, or changed by someone else. */
type Outcome<R> =
  | { readonly ok: true; readonly result: R }
  | {
      readonly ok: false;
      readonly kind: "rejected";
      readonly issues: ReadonlyArray<EnvironmentIssue>;
    }
  | { readonly ok: false; readonly kind: "stale"; readonly currentRevision: number };

/** Reads both lists again after a write: a name lives in one lane, so a write can move it. */
const useRefresh = (projectId: string) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.environment.environment.queryFilter({ projectId })),
      queryClient.invalidateQueries(trpc.environment.secrets.queryFilter({ projectId })),
    ]);
};

/** A field's own issues, under it. */
function Issues({ issues }: { readonly issues: ReadonlyArray<EnvironmentIssue> }) {
  if (issues.length === 0) return null;
  return <FieldError>{issues.map((issue) => issue.message).join(" ")}</FieldError>;
}

/**
 * Add variable… and Edit <name> (Doop "edit variable dialog"): a name and a value anyone who can
 * see the project can read. Editing can rename it. A name Mend won't take is said beside the field
 * before anything is sent; the server's refusal is said there too, and a change someone else made
 * meanwhile keeps the draft and says so.
 */
export function VariableDialog({
  projectId,
  projectName,
  editing,
  open,
  onOpenChange,
  finalFocus,
}: {
  readonly projectId: string;
  readonly projectName: string;
  /** The variable being edited, or null to add one. */
  readonly editing: VariableRow | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly finalFocus: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  const refresh = useRefresh(projectId);
  const phone = usePhone();
  const ids = useId();
  const [name, setName] = useState(editing?.name ?? "");
  const [value, setValue] = useState(editing?.value ?? "");
  const [issues, setIssues] = useState<ReadonlyArray<EnvironmentIssue>>([]);
  const [stale, setStale] = useState(false);
  const settle = async (outcome: Outcome<unknown>, saved: string): Promise<void> => {
    if (outcome.ok) {
      toast.add({ description: `Saved ${saved}.` });
      onOpenChange(false);
      await refresh();
      return;
    }
    if (outcome.kind === "rejected") setIssues(outcome.issues);
    else setStale(true);
  };
  const create = useMutation(trpc.environment.createVariable.mutationOptions());
  const update = useMutation(trpc.environment.updateVariable.mutationOptions());
  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;
  const size = phone ? "touch" : "default";
  const save = async () => {
    const trimmed = name.trim();
    const found = clientIssues({ name: trimmed, value });
    setIssues(found);
    setStale(false);
    if (found.length > 0) return;
    if (editing === null) {
      await settle(
        await create.mutateAsync({ projectId, request: { name: trimmed, value } }),
        trimmed,
      );
    } else {
      await settle(
        await update.mutateAsync({
          projectId,
          variableId: editing.id,
          request: { name: trimmed, value, expectedRevision: editing.revision },
        }),
        trimmed,
      );
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title={editing === null ? "Add variable" : `Edit ${editing.name}`}
      description={
        editing === null
          ? `Every ${projectName} session that starts after you save gets it as an environment variable.`
          : "Sessions that start after you save get the new value. Running sessions keep the old one until they stop."
      }
      size="md"
      finalFocus={finalFocus}
      footer={
        <>
          <Button
            variant="outline"
            size={size}
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size={size}
            disabled={pending || name.trim() === ""}
            onClick={() => void save().catch(() => undefined)}
          >
            {pending ? "Saving…" : editing === null ? "Add variable" : "Save variable"}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save().catch(() => undefined);
        }}
      >
        <Field data-invalid={issuesFor(issues, "name").length > 0 || undefined}>
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <Input
            id={`${ids}-name`}
            value={name}
            autoComplete="off"
            spellCheck={false}
            placeholder="NODE_ENV"
            className={cn("font-mono", phone && "h-11")}
            aria-invalid={issuesFor(issues, "name").length > 0}
            onChange={(event) => {
              setName(event.target.value);
              setIssues([]);
            }}
          />
          <Issues issues={issuesFor(issues, "name")} />
        </Field>
        <Field data-invalid={issuesFor(issues, "value").length > 0 || undefined}>
          <FieldLabel htmlFor={`${ids}-value`}>Value</FieldLabel>
          <Input
            id={`${ids}-value`}
            value={value}
            autoComplete="off"
            spellCheck={false}
            className={cn("font-mono", phone && "h-11")}
            aria-invalid={issuesFor(issues, "value").length > 0}
            onChange={(event) => {
              setValue(event.target.value);
              setIssues([]);
            }}
          />
          <FieldDescription>Anyone who can see {projectName} can read this value.</FieldDescription>
          <Issues issues={issuesFor(issues, "value")} />
        </Field>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      {stale && editing !== null ? (
        <InlineAlert size={size} title={`${editing.name} wasn't saved.`}>
          {staleWords(editing.name)}
        </InlineAlert>
      ) : issuesFor(issues, null).length > 0 ? (
        <InlineAlert size={size} title="It wasn't saved.">
          {issuesFor(issues, null)
            .map((issue) => issue.message)
            .join(" ")}
        </InlineAlert>
      ) : failure !== null ? (
        <InlineAlert size={size} title="It wasn't saved.">
          {failureWords(failure, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}

/**
 * Add secret… and Replace <name> (Doop "add secret dialog", "replace secret dialog"): the value goes
 * in a password field and is never shown again, to anyone. Replacing keeps the name.
 */
export function SecretDialog({
  projectId,
  projectName,
  replacing,
  open,
  onOpenChange,
  finalFocus,
}: {
  readonly projectId: string;
  readonly projectName: string;
  /** The secret being replaced, or null to add one. */
  readonly replacing: SecretRow | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly finalFocus: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  const refresh = useRefresh(projectId);
  const phone = usePhone();
  const ids = useId();
  const [name, setName] = useState(replacing?.name ?? "");
  const [value, setValue] = useState("");
  const [issues, setIssues] = useState<ReadonlyArray<EnvironmentIssue>>([]);
  const [stale, setStale] = useState(false);
  const create = useMutation(trpc.environment.createSecret.mutationOptions());
  const update = useMutation(trpc.environment.updateSecret.mutationOptions());
  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;
  const size = phone ? "touch" : "default";
  const close = () => {
    // The value never outlives the dialog.
    setValue("");
    onOpenChange(false);
  };
  const save = async () => {
    const trimmed = name.trim();
    const found = clientSecretIssues({ name: trimmed, value });
    setIssues(found);
    setStale(false);
    if (found.length > 0) return;
    const outcome: Outcome<unknown> =
      replacing === null
        ? await create.mutateAsync({ projectId, request: { name: trimmed, value } })
        : await update.mutateAsync({
            projectId,
            secretId: replacing.id,
            request: { name: replacing.name, value, expectedRevision: replacing.revision },
          });
    if (outcome.ok) {
      toast.add({
        description: replacing === null ? `Added ${trimmed}.` : `Replaced ${replacing.name}.`,
      });
      close();
      await refresh();
      return;
    }
    if (outcome.kind === "rejected") setIssues(outcome.issues);
    else setStale(true);
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) onOpenChange(true);
        else close();
      }}
      title={replacing === null ? "Add secret" : `Replace ${replacing.name}`}
      description={
        replacing === null
          ? `Every ${projectName} session gets it as an environment variable. Once you add it, nobody can read it back, you included. You can replace it later.`
          : "Mend keeps the new value sealed. Sessions that start after this get it. Running sessions keep the old value until they stop."
      }
      size="md"
      finalFocus={finalFocus}
      footer={
        <>
          <Button variant="outline" size={size} disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            size={size}
            disabled={pending || name.trim() === "" || value === ""}
            onClick={() => void save().catch(() => undefined)}
          >
            {pending ? "Saving…" : replacing === null ? "Add secret" : "Replace secret"}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save().catch(() => undefined);
        }}
      >
        {replacing === null ? (
          <Field data-invalid={issuesFor(issues, "name").length > 0 || undefined}>
            <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
            <Input
              id={`${ids}-name`}
              value={name}
              autoComplete="off"
              spellCheck={false}
              placeholder="STRIPE_SECRET_KEY"
              className={cn("font-mono", phone && "h-11")}
              aria-invalid={issuesFor(issues, "name").length > 0}
              onChange={(event) => {
                setName(event.target.value);
                setIssues([]);
              }}
            />
            <Issues issues={issuesFor(issues, "name")} />
          </Field>
        ) : null}
        <Field data-invalid={issuesFor(issues, "value").length > 0 || undefined}>
          <FieldLabel htmlFor={`${ids}-value`}>
            {replacing === null ? "Value" : "New value"}
          </FieldLabel>
          <Input
            id={`${ids}-value`}
            type="password"
            value={value}
            autoComplete="new-password"
            spellCheck={false}
            className={cn("font-mono", phone && "h-11")}
            aria-invalid={issuesFor(issues, "value").length > 0}
            onChange={(event) => {
              setValue(event.target.value);
              setIssues([]);
            }}
          />
          <FieldDescription>
            {replacing === null
              ? "Mend seals the value when you add it."
              : "You won't be able to see it again after you save."}
          </FieldDescription>
          <Issues issues={issuesFor(issues, "value")} />
        </Field>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      {stale && replacing !== null ? (
        <InlineAlert size={size} title={`${replacing.name} wasn't replaced.`}>
          {staleWords(replacing.name)}
        </InlineAlert>
      ) : issuesFor(issues, null).length > 0 ? (
        <InlineAlert size={size} title="It wasn't saved.">
          {issuesFor(issues, null)
            .map((issue) => issue.message)
            .join(" ")}
        </InlineAlert>
      ) : failure !== null ? (
        <InlineAlert size={size} title="It wasn't saved.">
          {failureWords(failure, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}

/** Remove <name>? for a variable or a secret: sessions that start later don't get it. */
export function RemoveEntryDialog({
  projectId,
  entry,
  onClose,
  finalFocus,
}: {
  readonly projectId: string;
  /** What is being removed, or null while nothing is. */
  readonly entry:
    | { readonly lane: "variable"; readonly row: VariableRow }
    | { readonly lane: "secret"; readonly row: SecretRow }
    | null;
  readonly onClose: () => void;
  readonly finalFocus: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  const refresh = useRefresh(projectId);
  const phone = usePhone();
  const [stale, setStale] = useState(false);
  const removeVariable = useMutation(trpc.environment.removeVariable.mutationOptions());
  const removeSecret = useMutation(trpc.environment.removeSecret.mutationOptions());
  const pending = removeVariable.isPending || removeSecret.isPending;
  const failure = removeVariable.error ?? removeSecret.error;
  const size = phone ? "touch" : "default";
  // The last entry stays while the dialog closes, so its words don't blank out as it fades.
  const [last, setLast] = useState(entry);
  if (entry !== null && entry !== last) setLast(entry);
  const shown = entry ?? last;
  const name = shown?.row.name ?? "";
  const remove = async () => {
    if (entry === null) return;
    setStale(false);
    const request = { expectedRevision: entry.row.revision };
    const outcome: Outcome<unknown> =
      entry.lane === "variable"
        ? await removeVariable.mutateAsync({ projectId, variableId: entry.row.id, request })
        : await removeSecret.mutateAsync({ projectId, secretId: entry.row.id, request });
    if (outcome.ok) {
      toast.add({ description: `Removed ${entry.row.name}.` });
      onClose();
      await refresh();
    } else setStale(true);
  };
  return (
    <Overlay
      open={entry !== null}
      onOpenChange={(next) => {
        if (!next && !pending) {
          setStale(false);
          onClose();
        }
      }}
      title={`Remove ${name}?`}
      description={
        shown?.lane === "secret"
          ? `Sessions that start after this don't get ${name}. Running sessions keep it until they stop. Mend deletes the sealed value, so adding it again means pasting it again.`
          : `Sessions that start after this don't get ${name}. Running sessions keep it until they stop.`
      }
      size="sm"
      finalFocus={finalFocus}
      footer={
        <>
          <Button variant="outline" size={size} disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size={size}
            disabled={pending || entry === null}
            onClick={() => void remove().catch(() => undefined)}
          >
            {pending ? "Removing…" : shown?.lane === "secret" ? "Remove secret" : "Remove variable"}
          </Button>
        </>
      }
    >
      {stale ? (
        <InlineAlert size={size} title={`${name} wasn't removed.`}>
          {staleWords(name)}
        </InlineAlert>
      ) : failure !== null ? (
        <InlineAlert size={size} title={`${name} wasn't removed.`}>
          {failureWords(failure, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}

/**
 * Import .env file…: paste a `.env` or choose one, and it becomes rows (comments and lines that
 * aren't `NAME=value` are left out, and the count of those is said). Each row says where it will
 * go: a secret-looking name goes to Secrets, a reserved name is refused with the reason, and
 * "Save everything as secrets" sends them all to Secrets. Values stay hidden unless shown, row by
 * row. Mend saves them in one request and reports by name; values never come back.
 */
export function ImportDialog({
  projectId,
  open,
  onOpenChange,
  finalFocus,
}: {
  readonly projectId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly finalFocus: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  const refresh = useRefresh(projectId);
  const phone = usePhone();
  const ids = useId();
  const [state, dispatch] = useReducer(composerReducer, initialComposer);
  const [text, setText] = useState("");
  const load = useMutation(trpc.environment.load.mutationOptions());
  const size = phone ? "touch" : "default";
  const close = () => {
    // Nothing pasted outlives the dialog.
    dispatch({ type: "reset" });
    setText("");
    load.reset();
    onOpenChange(false);
  };
  const keyed = state.rows.filter((row) => row.key !== "");
  const { postedRows, acceptedCount } = composerSubmission(state);
  const report = load.data;
  const save = async () => {
    const answer = await load.mutateAsync({
      projectId,
      request: {
        contents: serializeRows(postedRows),
        allSecret: state.allSecret,
        secretNames: [],
      },
    });
    await refresh();
    toast.add({ description: loadSummary(answer) });
    if (answer.rejected.length === 0) close();
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (load.isPending) return;
        if (next) onOpenChange(true);
        else close();
      }}
      title="Import .env file"
      description="Paste a .env file or choose one. Each line becomes a variable, or a secret when its name looks like one. Sessions that start after you save get them."
      size="lg"
      finalFocus={finalFocus}
      footer={
        <>
          <Button variant="outline" size={size} disabled={load.isPending} onClick={close}>
            {report === undefined ? "Cancel" : "Close"}
          </Button>
          <Button
            size={size}
            disabled={load.isPending || acceptedCount === 0}
            onClick={() => void save().catch(() => undefined)}
          >
            {load.isPending
              ? "Saving…"
              : `Save ${acceptedCount} ${acceptedCount === 1 ? "name" : "names"}`}
          </Button>
        </>
      }
    >
      {keyed.length === 0 ? (
        <Field>
          <FieldLabel htmlFor={`${ids}-paste`}>.env contents</FieldLabel>
          <Textarea
            id={`${ids}-paste`}
            value={text}
            rows={6}
            spellCheck={false}
            placeholder={"NODE_ENV=development\nSTRIPE_SECRET_KEY=…"}
            className="font-mono"
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              event.preventDefault();
              setText("");
              dispatch({ type: "text-expanded", intoId: null, text: pasted });
            }}
          />
          <FieldDescription>
            Pasting fills the rows below.{" "}
            <label className="cursor-pointer text-primary underline-offset-4 hover:underline">
              Choose a file
              <input
                type="file"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file === undefined) return;
                  void file
                    .text()
                    .then((contents) =>
                      dispatch({ type: "text-expanded", intoId: null, text: contents }),
                    );
                }}
              />
            </label>
          </FieldDescription>
          {text.trim() === "" ? null : (
            <Button
              variant="outline"
              size={size}
              className="justify-self-start"
              onClick={() => {
                dispatch({ type: "text-expanded", intoId: null, text });
                setText("");
              }}
            >
              Read it
            </Button>
          )}
        </Field>
      ) : (
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-4">
            <span>
              <label htmlFor={`${ids}-all-secret`} className="block font-medium">
                Save everything as secrets
              </label>
              <span className="block text-row text-muted-foreground">
                Off, only names that look secret go to Secrets.
              </span>
            </span>
            <Switch
              id={`${ids}-all-secret`}
              checked={state.allSecret}
              onCheckedChange={() => dispatch({ type: "all-secret-toggled" })}
            />
          </div>
          <ul aria-label="Names to import" className="border-y border-border">
            {keyed.map((row) => {
              const lane = rowLane(row, state.allSecret);
              const loaded = report?.loaded.find((entry) => entry.name === row.key);
              const refused = report?.rejected.find((entry) => entry.name === row.key);
              return (
                <li
                  key={row.id}
                  className="flex items-center gap-3 border-b border-border py-2 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm">{row.key}</p>
                    <p
                      className={cn(
                        "text-row",
                        lane.kind === "rejected" || refused !== undefined
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {refused !== undefined
                        ? refused.reason
                        : loaded !== undefined
                          ? `Saved as a ${loaded.lane === "secret" ? "secret" : "variable"}.`
                          : lane.kind === "rejected"
                            ? lane.reason
                            : lane.kind === "secret"
                              ? "Goes to Secrets."
                              : "Goes to Environment variables."}
                    </p>
                  </div>
                  <span className="max-w-40 truncate font-mono text-sm text-muted-foreground">
                    {row.revealed ? row.value : "••••••••"}
                  </span>
                  <Button
                    variant="ghost"
                    size={phone ? "touch" : "sm"}
                    aria-label={`${row.revealed ? "Hide" : "Show"} ${row.key}'s value`}
                    onClick={() => dispatch({ type: "reveal-toggled", id: row.id })}
                  >
                    {row.revealed ? "Hide" : "Show"}
                  </Button>
                  <Button
                    variant="ghost"
                    size={phone ? "touch" : "sm"}
                    aria-label={`Leave out ${row.key}`}
                    disabled={load.isPending}
                    onClick={() => dispatch({ type: "row-removed", id: row.id })}
                  >
                    Leave out
                  </Button>
                </li>
              );
            })}
          </ul>
          {state.skippedLines === 0 ? null : (
            <p className="text-row text-muted-foreground">
              {state.skippedLines === 1
                ? "1 line wasn't NAME=value, so it was left out."
                : `${state.skippedLines} lines weren't NAME=value, so they were left out.`}
            </p>
          )}
        </div>
      )}
      {load.isError ? (
        <InlineAlert size={size} title="Nothing was saved.">
          {failureWords(load.error, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}
