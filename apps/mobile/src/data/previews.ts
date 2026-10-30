import { PreviewStatus, previewStatusLine } from "@mend/domain/workbench";
import { Option, Schema } from "effect";

export interface WorktreePreviewsDto {
  readonly previews: ReadonlyArray<{
    readonly preview: { readonly id: string; readonly serviceName: string };
    readonly status: ReadonlyArray<string>;
    readonly facts?: ReadonlyArray<unknown>;
    readonly open?: string | null;
    readonly boundTo?: { readonly serviceId: string; readonly sessionId: string } | null;
  }>;
  readonly unprepared: string | null;
  readonly starting?: boolean;
  readonly routing?: "loopback-http" | "domain-https" | "tailnet-https" | null;
}

export interface PreviewOpeningDto {
  readonly url: string;
}

export interface PreviewToOpen {
  readonly id: string;
  readonly serviceName: string;
  readonly open: string;
}

export const previewToOpen = (
  read: WorktreePreviewsDto | undefined,
  sessionId: string,
): PreviewToOpen | null => {
  // A phone resolves `*.localhost` to itself (RFC 6761), never to the Mend machine.
  if (read === undefined || read.routing == null || read.routing === "loopback-http") return null;
  const served = read.previews.flatMap(({ preview, open, boundTo }) =>
    open == null ? [] : [{ id: preview.id, serviceName: preview.serviceName, open, boundTo }],
  );
  const chosen =
    served.find(({ boundTo }) => boundTo?.sessionId === sessionId) ?? served[0] ?? null;
  return chosen === null
    ? null
    : { id: chosen.id, serviceName: chosen.serviceName, open: chosen.open };
};

const decodeStatus = Schema.decodeUnknownOption(PreviewStatus);

export interface PreviewRow {
  readonly key: string;
  readonly serviceName: string;
  readonly lines: ReadonlyArray<string>;
}

export const previewRowsOf = (
  read: WorktreePreviewsDto | undefined,
  now: Date,
): ReadonlyArray<PreviewRow> =>
  (read?.previews ?? []).flatMap(({ preview, status, facts }) => {
    const lines =
      facts === undefined
        ? status
        : facts.flatMap((fact, index) =>
            Option.match(decodeStatus(fact), {
              onNone: () => status.slice(index, index + 1),
              onSome: (decoded) => [previewStatusLine(decoded, { now })],
            }),
          );
    return lines.length === 0 ? [] : [{ key: preview.id, serviceName: preview.serviceName, lines }];
  });

export type PreviewOpenFailure =
  | { readonly _tag: "Refused"; readonly message: string }
  | { readonly _tag: "BrowserFailed"; readonly reason: string };

export const previewOpenFailureLine = (failure: PreviewOpenFailure): string =>
  failure._tag === "Refused"
    ? `preview · ${failure.message}`
    : `preview · the in-app browser did not open · ${failure.reason}`;

/**
 * Where a preview opens. It is reserved in the press, before the ticket is minted, because a web
 * browser only lets a page open a tab while it handles the person's press.
 */
export interface PreviewBrowser {
  readonly show: (url: string) => Promise<string | null>;
  readonly abandon: () => void;
}

export type ReservePreviewBrowser = () => PreviewBrowser;

export const browserRefusalOf = (answer: { readonly type: string }): string | null =>
  answer.type === "locked" ? "another in-app browser is already open" : null;

export const browserFailureOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : String(error);

/**
 * The open settles once the URL is minted: on iOS the browser answers only when it is dismissed,
 * so its answer arrives later, through `onBrowserFailure`.
 */
export const openPreviewIn = async (
  browser: PreviewBrowser,
  mint: () => Promise<PreviewOpeningDto>,
  onBrowserFailure: (reason: string) => void,
): Promise<void> => {
  const opening = await mint().catch((error: unknown) => {
    browser.abandon();
    throw error;
  });
  void browser
    .show(opening.url)
    .then((reason) => (reason === null ? undefined : onBrowserFailure(reason)));
};
