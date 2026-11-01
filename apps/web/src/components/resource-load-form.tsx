import { loadBytes, loadIsLive, ResourceLoadAnswer } from "@mend/domain/workbench";
import { Schema } from "effect";
import { useState } from "react";

const field =
  "rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground";
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

/** A load is an action on the Resources card. The URL is cleared before any response is shown. */
export function ResourceLoadForm(props: {
  readonly projectId: string;
  readonly name: string;
  readonly worktreeId: string | null;
  readonly mayLoadOwn: boolean;
  readonly worktreeResource: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<"shared" | "own">(props.mayLoadOwn ? "own" : "shared");
  const [kind, setKind] = useState<"file" | "url">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const submit = async () => {
    if (busy || (kind === "file" ? file === null : url.trim() === "")) return;
    setBusy(true);
    const source =
      kind === "file"
        ? { kind: "upload", label: file?.name ?? "dump", bytesTotal: file?.size ?? 0 }
        : { kind: "pull", url };
    setUrl("");
    const zone = `timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}`;
    const base = `/api/projects/${encodeURIComponent(props.projectId)}/resource-loads`;
    try {
      let row = await read(
        await fetch(`${base}?${zone}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: props.name,
            worktreeId: props.worktreeId,
            target: props.worktreeResource ? "own" : target,
            source,
          }),
        }),
      );
      setLine(row.statusLine);
      const route = `${base}/${encodeURIComponent(row.id)}`;
      if (kind === "file" && file !== null)
        await uploadResourceFile(`${route}/body?${zone}`, file, (bytes) =>
          setLine(
            `@${props.name} · loading ${file.name} · receiving ${loadBytes(bytes)} of ${loadBytes(file.size)} · ${target} database`,
          ),
        );
      while (loadIsLive(row.phase)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        row = await read(await fetch(`${route}?${zone}`));
        setLine(row.statusLine);
      }
    } catch (error) {
      setLine(error instanceof Error ? error.message : "the load could not finish");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3">
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground"
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        Load data into @{props.name}
      </button>
      {open ? (
        <form
          className="mt-2 grid gap-2"
          aria-label={`Load data into @${props.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="text-xs">
            Target database{" "}
            <select
              aria-label={`Target database for @${props.name}`}
              className={`${field} ml-2`}
              disabled={busy || props.worktreeResource}
              value={props.worktreeResource ? "own" : target}
              onChange={(event) => setTarget(event.target.value === "own" ? "own" : "shared")}
            >
              {props.worktreeResource ? null : <option value="shared">Shared database</option>}
              {props.worktreeId !== null && props.mayLoadOwn ? (
                <option value="own">This worktree's own database</option>
              ) : null}
            </select>
          </label>
          <label className="text-xs">
            Source{" "}
            <select
              aria-label={`Load source for @${props.name}`}
              className={`${field} ml-2`}
              disabled={busy}
              value={kind}
              onChange={(event) => setKind(event.target.value === "url" ? "url" : "file")}
            >
              <option value="file">Dump file</option>
              <option value="url">Postgres URL, pulled by Mend</option>
            </select>
          </label>
          {kind === "file" ? (
            <label className="text-xs">
              Dump file{" "}
              <input
                aria-label={`Dump file for @${props.name}`}
                type="file"
                disabled={busy}
                className={`${field} ml-2`}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
          ) : (
            <label className="text-xs">
              Postgres URL{" "}
              <input
                aria-label={`Postgres URL for @${props.name}`}
                type="password"
                autoComplete="off"
                disabled={busy}
                value={url}
                className={`${field} ml-2 w-full`}
                placeholder="postgres://host/database"
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            Mend replaces the target's data and keeps its previous data as a checked dump.
          </p>
          <button
            type="submit"
            className="justify-self-start rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
            disabled={busy || (kind === "file" ? file === null : url.trim() === "")}
          >
            {busy ? "Loading…" : "Load"}
          </button>
        </form>
      ) : null}
      {line === null ? null : (
        <p role="status" className="mt-2 font-mono text-xs break-words">
          {line}
        </p>
      )}
    </div>
  );
}
