import { SECRET_FILE_MAX_BYTES, validateSecretFilePath } from "@mend/domain/workbench";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import {
  deleteSecretFile,
  putSecretFile,
  type SecretFileDto,
  type SecretFilesDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

const INPUT =
  "mt-1.5 w-full rounded-xl border border-input bg-card px-3.5 py-2.5 font-mono text-[12.5px] text-foreground outline-none transition-colors focus:border-[var(--sw-accent)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--sw-accent)_18%,transparent)] disabled:opacity-60";

const QUIET_BUTTON =
  "font-sans text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60";

/** Bytes as a terse mono fact: 116 B, 4.1 KB. */
const sizeOf = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** The home-relative path a typed `~/.aws/credentials` means. */
const homeRelative = (typed: string) => {
  const trimmed = typed.trim();
  return trimmed.startsWith("~/") ? trimmed.slice(2) : trimmed;
};

/** A chosen file's bytes as base64, read in the browser; nothing leaves the page but the upload. */
const readAsBase64 = (file: File): Promise<string> =>
  file.arrayBuffer().then((buffer) => {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  });

type Chosen = { readonly name: string; readonly bytes: number; readonly base64: string };

/**
 * The account setting "Secret files" (docs/adr/0010): the files written into every workspace a
 * session of this account launches in, by path and size. Content is write-only: it is sent once,
 * sealed on the server, and never shown here again.
 */
export function SecretFilesPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const view = useSuspenseQuery(trpc.settings.secretFiles.queryOptions()).data;
  const [pathTyped, setPathTyped] = useState("");
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState<"save" | string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputId = useId();

  const relativePath = homeRelative(pathTyped);
  const pathIssue = relativePath === "" ? null : validateSecretFilePath(relativePath);
  const content = chosen !== null ? "file" : pasted.length > 0 ? "text" : null;
  const chosenIssue =
    chosen !== null && chosen.bytes > SECRET_FILE_MAX_BYTES
      ? `${chosen.name} is over ${SECRET_FILE_MAX_BYTES / 1024} KB`
      : null;
  const canSave =
    busy === null &&
    relativePath !== "" &&
    pathIssue === null &&
    content !== null &&
    chosenIssue === null;

  const settle = (next: SecretFilesDto) => {
    queryClient.setQueryData(trpc.settings.secretFiles.queryOptions().queryKey, next);
  };

  const save = () => {
    if (!canSave) return;
    setBusy("save");
    setSaid(null);
    setError(null);
    const saving = putSecretFile(
      chosen !== null
        ? { path: relativePath, encoding: "base64", contents: chosen.base64 }
        : { path: relativePath, encoding: "utf8", contents: pasted },
    ).then((saved) => {
      settle({
        files: [...view.files.filter((file) => file.path !== saved.file.path), saved.file].toSorted(
          (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
        ),
      });
      setSaid(`${saved.action} ~/${saved.file.path} · ${sizeOf(saved.file.bytes)}`);
      setPathTyped("");
      setChosen(null);
      setPasted("");
      return saved;
    });
    void saving
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };

  const remove = (file: SecretFileDto) => {
    setBusy(file.path);
    setSaid(null);
    setError(null);
    const removing = deleteSecretFile(file.path).then((removed) => {
      if (removed.removed) settle({ files: view.files.filter((row) => row.path !== file.path) });
      setSaid(`removed ~/${file.path}`);
      return removed;
    });
    void removing
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };

  const choose = (file: File | undefined) => {
    setSaid(null);
    if (file === undefined) {
      setChosen(null);
      return;
    }
    void readAsBase64(file).then((base64) =>
      setChosen({ name: file.name, bytes: file.size, base64 }),
    );
  };

  return (
    <section id="secret-files" className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <h2 className="font-sans text-sm font-semibold">Secret files</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Files written into every workspace a session of yours launches in, before the agent starts:{" "}
        <span className="font-mono text-xs text-ink-2">~/.aws/credentials</span>, a kubeconfig, an{" "}
        <span className="font-mono text-xs text-ink-2">.npmrc</span> token file. Encrypted at rest
        with the same key as project secrets. The content is never shown again, and never captured:
        a secret file goes into the workspace&apos;s own home directory, which no capture, change,
        checkpoint or transcript harvest covers. Yours alone. Applies to sessions launched from now
        on.
      </p>

      <div className="mt-5 border-t border-[var(--sw-faint-rule)] pt-5">
        {view.files.length === 0 ? (
          <p className="font-mono text-xs text-faint">none kept</p>
        ) : (
          <ul className="divide-y divide-[var(--sw-faint-rule)]">
            {view.files.map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[12.5px] text-foreground">~/{file.path}</p>
                  <p className="mt-0.5 font-mono text-xs text-faint">
                    {sizeOf(file.bytes)} · {dayOf(file.updatedAt)}
                    {file.revision > 1 ? ` · replaced ${file.revision - 1}×` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => remove(file)}
                  className={`${QUIET_BUTTON} shrink-0`}
                >
                  {busy === file.path ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-5 grid gap-4 border-t border-[var(--sw-faint-rule)] pt-5 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="font-sans text-[13px] font-medium text-foreground">
            Path in the workspace
          </span>
          <input
            type="text"
            value={pathTyped}
            disabled={busy !== null}
            spellCheck={false}
            autoComplete="off"
            placeholder=".aws/credentials"
            onChange={(event) => {
              setSaid(null);
              setPathTyped(event.target.value);
            }}
            className={INPUT}
          />
          <span className="mt-1 block font-mono text-xs text-faint">
            relative to the home directory · a path already kept is replaced
          </span>
        </label>
        <div className="block">
          <span className="font-sans text-[13px] font-medium text-foreground">File</span>
          <div className="mt-1.5 flex items-center gap-3">
            <label
              htmlFor={fileInputId}
              className="inline-flex min-h-9 cursor-pointer items-center justify-center rounded-xl border border-border bg-card px-4 font-sans text-[13px] font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5"
            >
              Choose file
            </label>
            <input
              id={fileInputId}
              type="file"
              className="sr-only"
              disabled={busy !== null || pasted.length > 0}
              onChange={(event) => choose(event.target.files?.[0])}
            />
            <span className="min-w-0 truncate font-mono text-xs text-faint">
              {chosen === null ? "none chosen" : `${chosen.name} · ${sizeOf(chosen.bytes)}`}
            </span>
          </div>
        </div>
        <label className="block">
          <span className="font-sans text-[13px] font-medium text-foreground">
            Or paste its text
          </span>
          <textarea
            value={pasted}
            disabled={busy !== null || chosen !== null}
            spellCheck={false}
            rows={3}
            onChange={(event) => {
              setSaid(null);
              setPasted(event.target.value);
            }}
            className={`${INPUT} resize-y`}
          />
        </label>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <p className="font-mono text-xs text-faint">
          {said ??
            `${view.files.length} kept · up to 64 · each at most ${SECRET_FILE_MAX_BYTES / 1024} KB`}
        </p>
        <button
          type="button"
          disabled={!canSave}
          onClick={save}
          className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-xl bg-primary px-4 font-sans text-[13px] font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-60"
        >
          {busy === "save" ? "Saving…" : "Add secret file"}
        </button>
      </div>
      {pathIssue === null && chosenIssue === null && error === null ? null : (
        <p className="mt-4 border-l-2 border-danger pl-3 text-[13px] text-danger">
          {error ?? chosenIssue ?? pathIssue}
        </p>
      )}
    </section>
  );
}
