import type { ProcessLogPageDto, SessionProcessDto } from "#/lib/api";

/**
 * Reading a process's recorded PTY output back (`GET /api/processes/:id/logs`). The record
 * outlives the process and its workspace, so an ended session's terminal replays from here, not
 * from `/api/tty`, which only attaches a live PTY.
 */

/** One record chunk's bytes, exactly as the PTY wrote them. */
export const base64Bytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** The page cap: a record longer than this many pages of 1000 chunks stops with a note. */
export const MAX_RECORD_PAGES = 128;

export type FetchRecordPage = (from: string) => Promise<ProcessLogPageDto>;

/**
 * Every page from `from` to the end of the record, in order. The walk ends on an empty page or a
 * cursor that stops moving; `truncated` says the cap ended it first.
 */
export async function* recordPages(
  fetchPage: FetchRecordPage,
  from: string,
  maxPages: number = MAX_RECORD_PAGES,
): AsyncGenerator<ProcessLogPageDto, { readonly truncated: boolean }> {
  let cursor = from;
  for (let page = 0; page < maxPages; page += 1) {
    const next = await fetchPage(cursor);
    yield next;
    if (next.chunks.length === 0 || next.nextFrom === cursor) return { truncated: false };
    cursor = next.nextFrom;
  }
  return { truncated: true };
}

/**
 * The ended process's terse fact line: its observed status, the exit code when the platform
 * reported one, and "observed" — what happened, never a judgment of the work.
 */
export const processEndFact = (process: SessionProcessDto): string =>
  process.exitCode === null
    ? `${process.status} · observed`
    : `${process.status} · code ${process.exitCode} · observed`;
