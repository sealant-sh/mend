import type { WorktreeId } from "@mend/domain";
import { loadBytes, loadIsLive, ResourceLoadAnswer } from "@mend/domain/workbench";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, GroupField, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { Segment } from "#/components/kit/segment";
import { readerZone } from "#/lib/resources";
import { useTRPC } from "#/lib/trpc";

const decode = Schema.decodeUnknownSync(ResourceLoadAnswer);
const read = async (response: Response) => {
  if (!response.ok) throw new Error(`Mend refused this load (${response.status})`);
  return decode(await response.json());
};

/** File bytes go directly to the raw API, with the browser's measured upload progress. */
export const uploadResourceFile = (
  route: string,
  file: File,
  progress: (bytes: number) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      if (error === null) {
        resolve();
        return;
      }
      reject(new Error(error));
    };
    xhr.open("PUT", route);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => progress(event.loaded));
    xhr.addEventListener(
      "load",
      () => finish(xhr.status === 200 ? null : `Mend refused the upload (${xhr.status})`),
      { once: true },
    );
    xhr.addEventListener("error", () => finish("the upload connection ended"), { once: true });
    xhr.addEventListener("abort", () => finish("the upload ended"), { once: true });
    xhr.send(file);
  });

/** Where a load can go: the shared database, or a worktree's own one its owner may replace. */
export interface LoadTargets {
  readonly shared: boolean;
  readonly own: ReadonlyArray<{ readonly id: WorktreeId; readonly name: string }>;
}

/** What the dialog shows while a load runs: the server's line, and bytes when they are counted. */
interface Progress {
  readonly line: string;
  readonly done: number;
  readonly total: number | null;
  readonly phase: ResourceLoadAnswer["phase"] | "uploading";
}

type Into = "shared" | "own";
type From = "file" | "url";

/**
 * Load data into a Postgres resource (screen K5). Mend saves the current data as a dump first;
 * the dialog shows the server's own line for every phase (receiving, restoring, saving…) and the
 * bytes the browser has sent, never a guess. While a load runs it cannot be dismissed.
 */
export function LoadDataDialog({
  projectId,
  name,
  targets,
  open,
  onOpenChange,
}: {
  readonly projectId: string;
  readonly name: string;
  readonly targets: LoadTargets;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [into, setInto] = useState<Into>(targets.shared ? "shared" : "own");
  const [ownId, setOwnId] = useState<WorktreeId | null>(targets.own[0]?.id ?? null);
  const [from, setFrom] = useState<From>("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);

  const load = useMutation({
    mutationFn: async (request: {
      readonly into: Into;
      readonly worktreeId: WorktreeId | null;
      readonly source:
        | { readonly kind: "upload"; readonly file: File }
        | { readonly kind: "pull"; readonly url: string };
    }) => {
      const zone = `timeZone=${encodeURIComponent(readerZone())}`;
      const base = `/api/projects/${encodeURIComponent(projectId)}/resource-loads`;
      const { source } = request;
      let row = await read(
        await fetch(`${base}?${zone}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            worktreeId: request.worktreeId,
            target: request.into,
            source:
              source.kind === "upload"
                ? { kind: "upload", label: source.file.name, bytesTotal: source.file.size }
                : { kind: "pull", url: source.url },
          }),
        }),
      );
      const show = (answer: ResourceLoadAnswer) =>
        setProgress({
          line: answer.statusLine,
          done: answer.bytesDone,
          total: answer.bytesTotal,
          phase: answer.phase,
        });
      show(row);
      const route = `${base}/${encodeURIComponent(row.id)}`;
      if (source.kind === "upload")
        await uploadResourceFile(`${route}/body?${zone}`, source.file, (bytes) =>
          setProgress({
            line: `sending ${source.file.name} · ${loadBytes(bytes)} of ${loadBytes(source.file.size)} · ${request.into === "own" ? "own" : "shared"} database`,
            done: bytes,
            total: source.file.size,
            phase: "uploading",
          }),
        );
      while (loadIsLive(row.phase)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        row = await read(await fetch(`${route}?${zone}`));
        show(row);
      }
      return row;
    },
    onSettled: () => queryClient.invalidateQueries(trpc.resources.pathFilter()),
  });

  const ready =
    (into === "shared" ? targets.shared : ownId !== null) &&
    (from === "file" ? file !== null : url.trim() !== "");
  const finished = load.data;

  const close = (next: boolean) => {
    // A load in flight cannot be abandoned halfway: Escape and the backdrop wait for it.
    if (load.isPending) return;
    if (!next) {
      setProgress(null);
      setFile(null);
      setUrl("");
      load.reset();
    }
    onOpenChange(next);
  };

  const submit = () => {
    if (!ready || load.isPending) return;
    const source =
      from === "file" && file !== null
        ? { kind: "upload" as const, file }
        : { kind: "pull" as const, url: url.trim() };
    // The URL can carry a password: it leaves the field before anything answers.
    setUrl("");
    setProgress(null);
    load.mutate({ into, worktreeId: into === "own" ? ownId : null, source });
  };

  const intoOptions = [
    ...(targets.shared ? [{ value: "shared" as const, label: "Shared database" }] : []),
    ...(targets.own.length > 0
      ? [{ value: "own" as const, label: "This worktree's own database" }]
      : []),
  ];

  return (
    <ModalDialog
      open={open}
      onOpenChange={close}
      title={`Load data into @${name}`}
      description="Mend saves the current data as a dump first, so you can go back."
      width={520}
    >
      <form
        className="grid gap-4"
        aria-label={`Load data into @${name}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {intoOptions.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            Nothing here can take a load yet: start @{name} as a project resource, or own a worktree
            that uses its own database.
          </p>
        ) : (
          <GroupField label="Into">
            <Segment
              label="Into"
              value={into}
              options={intoOptions}
              onChange={setInto}
              disabled={load.isPending}
            />
          </GroupField>
        )}
        {into === "own" && targets.own.length > 1 ? (
          <GroupField label="Worktree">
            <Segment
              label="Worktree"
              value={ownId ?? targets.own[0]?.id ?? ""}
              options={targets.own.map((worktree) => ({
                value: worktree.id,
                label: <span className="font-mono text-[12.5px]">{worktree.name}</span>,
              }))}
              onChange={(id) => setOwnId(targets.own.find((row) => row.id === id)?.id ?? null)}
              disabled={load.isPending}
            />
          </GroupField>
        ) : null}
        <GroupField label="From">
          <Segment
            label="From"
            value={from}
            options={[
              { value: "file", label: "Dump file" },
              { value: "url", label: "Postgres URL, pulled by Mend" },
            ]}
            onChange={setFrom}
            disabled={load.isPending}
          />
        </GroupField>
        {from === "file" ? (
          <Field label="Dump file">
            {(id) => (
              <input
                id={id}
                type="file"
                disabled={load.isPending}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="w-full rounded-[10px] border border-input bg-panel px-3 py-[7px] font-mono text-[13px] text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-2 file:py-1 file:font-sans file:text-[12px] file:text-ink-2"
              />
            )}
          </Field>
        ) : (
          <Field label="Postgres URL">
            {(id) => (
              <TextInput
                id={id}
                type="password"
                autoComplete="off"
                value={url}
                disabled={load.isPending}
                placeholder="postgres://host/database"
                onChange={(event) => setUrl(event.target.value)}
              />
            )}
          </Field>
        )}
        <div role="status" aria-live="polite" className="grid gap-1.5 empty:hidden">
          {progress === null ? null : (
            <>
              <p className="font-mono text-[12px] break-words text-ink-2">{progress.line}</p>
              {progress.total !== null && progress.total > 0 && loadIsLiveOrSending(progress) ? (
                <progress
                  aria-label={`@${name} load progress`}
                  value={Math.min(progress.done, progress.total)}
                  max={progress.total}
                  className="h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-secondary [&::-webkit-progress-value]:bg-primary"
                />
              ) : null}
            </>
          )}
        </div>
        <p role="alert" className="font-mono text-[12px] text-danger empty:hidden">
          {load.isError
            ? load.error.message
            : finished?.phase === "failed"
              ? "The load did not finish; the database was not changed."
              : ""}
        </p>
        <div className="flex items-center justify-end gap-2.5">
          {finished === undefined ? (
            <>
              <Button variant="ghost" onClick={() => close(false)} disabled={load.isPending}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!ready || load.isPending}>
                {load.isPending ? "Loading…" : "Load"}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => close(false)}>
              Done
            </Button>
          )}
        </div>
      </form>
    </ModalDialog>
  );
}

const loadIsLiveOrSending = (progress: Progress) =>
  progress.phase === "uploading" || loadIsLive(progress.phase);
