import type { WorktreeId } from "@mend/domain";
import {
  loadBytes,
  loadIsLive,
  ResourceLoadAnswer,
  type ResourceLoadPhase,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import { readerZone } from "./resources.ts";

/**
 * Loading data into a Postgres resource (ADR 0019, story 9). The bytes of a dump go straight to
 * the API, never through tRPC: `POST /api/projects/:id/resource-loads` opens the load, a file's
 * bytes go to `…/:loadId/body`, and the load is read again each second until it is done or failed.
 * Mend saves the database's current data as a dump before it replaces it, and a URL's password is
 * never sent back.
 */

/** Which database a load replaces: the shared one, or one worktree's own. */
export type LoadTarget = "shared" | "own";

export type LoadSource =
  | { readonly kind: "upload"; readonly file: File }
  | { readonly kind: "pull"; readonly url: string };

export interface LoadRequest {
  readonly projectId: string;
  readonly name: string;
  readonly target: LoadTarget;
  /** The worktree whose own database it replaces; null for the shared one. */
  readonly worktreeId: WorktreeId | null;
  readonly source: LoadSource;
}

/** Where a load stands: the server's line, or the browser's while it sends a file. */
export interface LoadProgress {
  readonly line: string;
  readonly done: number;
  readonly total: number | null;
  readonly phase: ResourceLoadPhase | "sending";
}

/** Whether a progress bar means something: a known size, and a load still under way. */
export const showsBar = (progress: LoadProgress): boolean =>
  progress.total !== null &&
  progress.total > 0 &&
  (progress.phase === "sending" || loadIsLive(progress.phase));

/** The line while the browser sends a file: `Sending staging.dump: 21 MB of 38 MB.` */
export const sendingLine = (label: string, done: number, total: number): string =>
  `Sending ${label}: ${loadBytes(done)} of ${loadBytes(total)}.`;

const decode = Schema.decodeUnknownSync(ResourceLoadAnswer);

const Refusal = Schema.Struct({ message: Schema.String });
const refusalOf = Schema.decodeUnknownOption(Refusal);

/** The load as the server answered, or its refusal in its own words when it gave some. */
const answerOf = async (response: Response): Promise<ResourceLoadAnswer> => {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return decode(body);
  const refusal = refusalOf(body);
  throw new Error(
    refusal._tag === "Some"
      ? refusal.value.message
      : `Mend refused the load (HTTP ${response.status}).`,
  );
};

/** A file's bytes, with the progress the browser measures as it sends them. */
const upload = (url: string, file: File, sent: (bytes: number) => void): Promise<void> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => sent(event.loaded));
    xhr.addEventListener(
      "load",
      () => {
        if (xhr.status === 200) resolve();
        else reject(new Error(`Mend refused the upload (HTTP ${xhr.status}).`));
      },
      { once: true },
    );
    xhr.addEventListener("error", () => reject(new Error("The upload's connection ended.")), {
      once: true,
    });
    xhr.addEventListener("abort", () => reject(new Error("The upload was cancelled.")), {
      once: true,
    });
    xhr.send(file);
  });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs one load to its end, reporting each step; resolves with the load as it finished. */
export const runResourceLoad = async (
  request: LoadRequest,
  report: (progress: LoadProgress) => void,
): Promise<ResourceLoadAnswer> => {
  const zone = `timeZone=${encodeURIComponent(readerZone())}`;
  const base = `/api/projects/${encodeURIComponent(request.projectId)}/resource-loads`;
  const { source } = request;
  const show = (answer: ResourceLoadAnswer) =>
    report({
      line: answer.statusLine,
      done: answer.bytesDone,
      total: answer.bytesTotal,
      phase: answer.phase,
    });
  let answer = await answerOf(
    await fetch(`${base}?${zone}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: request.name,
        worktreeId: request.worktreeId,
        target: request.target,
        source:
          source.kind === "upload"
            ? { kind: "upload", label: source.file.name, bytesTotal: source.file.size }
            : { kind: "pull", url: source.url },
      }),
    }),
  );
  show(answer);
  const route = `${base}/${encodeURIComponent(answer.id)}`;
  if (source.kind === "upload") {
    const { file } = source;
    await upload(`${route}/body?${zone}`, file, (bytes) =>
      report({
        line: sendingLine(file.name, bytes, file.size),
        done: bytes,
        total: file.size,
        phase: "sending",
      }),
    );
  }
  while (loadIsLive(answer.phase)) {
    await pause(1000);
    answer = await answerOf(await fetch(`${route}?${zone}`));
    show(answer);
  }
  return answer;
};
