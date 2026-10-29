import type { PageRef } from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/data/live";
import { transcriptPageOf } from "@/data/pages";

export interface TranscriptEventDto {
  readonly kind: string;
  readonly text: string | null;
  readonly name: string | null;
  readonly command: string | null;
  readonly output: string | null;
  readonly page: PageRef | null;
}

type TranscriptEventWire = Omit<TranscriptEventDto, "page"> & { readonly page?: unknown };

export interface TranscriptWire {
  readonly sourceHarness: string;
  readonly events: ReadonlyArray<TranscriptEventWire>;
}

export const readTranscript = (transcript: TranscriptWire) => ({
  sourceHarness: transcript.sourceHarness,
  events: transcript.events.map(
    (event): TranscriptEventDto => ({ ...event, page: transcriptPageOf(event) }),
  ),
});

export const useTranscript = (sessionId: string, live: boolean) =>
  useQuery({
    queryKey: ["transcript", sessionId],
    queryFn: async () =>
      readTranscript(await api<TranscriptWire>("GET", `/sessions/${sessionId}/transcript`)),
    refetchInterval: live ? 1_500 : false,
  });
