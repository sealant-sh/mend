import type { ProofArtifactView } from "@mend/api-contracts";
import { Modal, ModalHeader } from "@mend/ui/modal";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImageOff, Video } from "lucide-react";
import { useState } from "react";

import { useTRPC } from "#/lib/trpc";

export function ChangeProofArtifacts({ changeId }: { readonly changeId: string }) {
  const trpc = useTRPC();
  const captures = useQuery(trpc.changes.proofArtifacts.queryOptions({ changeId }));
  const [openId, setOpenId] = useState<string | null>(null);
  const open = captures.data?.find((view) => view.artifact.id === openId);
  if (captures.isSuccess && captures.data.length === 0) return null;
  return (
    <section aria-label="Proof artifacts" className="mt-8">
      <h2 className="text-xs font-medium text-label">Proof artifacts</h2>
      <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-sm">
        {captures.isError ? (
          <div role="status" className="p-4 text-[13px] text-ink-2">
            <p>The proof artifacts could not be read.</p>
            <button
              type="button"
              onClick={() => void captures.refetch()}
              className="mt-2 text-info hover:underline"
            >
              Try again
            </button>
          </div>
        ) : captures.isPending ? (
          <p role="status" className="p-4 text-[13px] text-muted-foreground">
            Reading proof artifacts…
          </p>
        ) : (
          <ul className="divide-y divide-rule-faint">
            {captures.data.map((view) => (
              <li key={view.artifact.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(view.artifact.id)}
                  className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-secondary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <span
                    className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary"
                    aria-hidden="true"
                  >
                    {view.mediaPath !== null && view.artifact.capture._tag === "Screenshot" ? (
                      <img
                        src={view.mediaPath}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-contain"
                      />
                    ) : view.mediaPath !== null && view.artifact.capture._tag === "Video" ? (
                      <video
                        // Seeking just past the start also paints a thumbnail in Safari.
                        src={`${view.mediaPath}#t=0.001`}
                        muted
                        playsInline
                        preload="metadata"
                        className="h-full w-full object-contain"
                      />
                    ) : view.artifact.capture._tag === "Recording" ? (
                      <Video className="size-5 text-faint" />
                    ) : (
                      <ImageOff className="size-5 text-faint" />
                    )}
                  </span>
                  <span className="min-w-0 break-words text-[13px]">{view.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open === undefined ? null : (
        <ProofArtifactDialog key={open.artifact.id} view={open} onClose={() => setOpenId(null)} />
      )}
    </section>
  );
}

function ProofArtifactDialog({
  view,
  onClose,
}: {
  readonly view: ProofArtifactView;
  readonly onClose: () => void;
}) {
  const { artifact, label, mediaPath } = view;
  const capture = artifact.capture;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const position =
    capture._tag === "Screenshot"
      ? `screen log · seq ${capture.moment.seq}`
      : capture._tag === "Video"
        ? `screen log · seq ${capture.span.fromSeq}–${capture.span.toSeq}`
        : capture._tag === "Recording"
          ? `screen log · seq ${capture.fromSeq}`
          : null;
  return (
    <Modal
      label={artifact.title}
      onClose={onClose}
      maxWidth={1120}
      header={
        <ModalHeader title={artifact.title}>
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </ModalHeader>
      }
    >
      <div className="space-y-4 p-4">
        <p className="font-mono text-xs text-ink-2">{label}</p>
        {failed ? (
          <div role="status" className="text-[13px] text-ink-2">
            <p>This capture could not be loaded.</p>
            <button
              type="button"
              className="mt-2 text-info hover:underline"
              onClick={() => {
                setFailed(false);
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </button>
          </div>
        ) : mediaPath !== null && capture._tag === "Screenshot" ? (
          <img
            key={attempt}
            src={mediaPath}
            alt={artifact.caption || artifact.title}
            onError={() => setFailed(true)}
            className="max-h-[60vh] w-full object-contain"
          />
        ) : mediaPath !== null && capture._tag === "Video" ? (
          <video
            key={attempt}
            src={mediaPath}
            controls
            playsInline
            aria-label={artifact.title}
            preload="metadata"
            onError={() => setFailed(true)}
            className="max-h-[60vh] w-full"
          />
        ) : (
          <p className="text-[13px] text-muted-foreground">
            {capture._tag === "NotCaptured" ? `Not captured · ${capture.reason}` : "Recording…"}
          </p>
        )}
        <p className="whitespace-pre-wrap text-[13px] text-ink-2">{artifact.caption}</p>
        {artifact.source._tag === "Unknown" ? (
          <p className="text-[13px] text-muted-foreground">
            Source unknown · {artifact.source.reason}
          </p>
        ) : null}
        {artifact.sessionId === null ? (
          <p className="text-[13px] text-muted-foreground">Session removed</p>
        ) : (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: artifact.sessionId }}
            className="text-[13px] text-info hover:underline"
          >
            Open session
          </Link>
        )}
        {artifact.launch === null ? null : (
          <div>
            <p className="text-xs text-label">launch</p>
            <p className="whitespace-pre-wrap break-words font-mono text-xs text-ink-2">
              {artifact.launch}
            </p>
          </div>
        )}
        {artifact.differences === null ? null : (
          <div>
            <p className="text-xs text-label">differences</p>
            <p className="whitespace-pre-wrap text-[13px] text-ink-2">{artifact.differences}</p>
          </div>
        )}
        {position === null ? null : <p className="font-mono text-xs text-faint">{position}</p>}
      </div>
    </Modal>
  );
}
