import type { ProofArtifactView } from "@mend/api-contracts";
import { Button } from "@mend/ui/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImageOffIcon, VideoIcon } from "lucide-react";
import { useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import { QueryError } from "#/components/route-screens";
import { useTRPC } from "#/lib/trpc";

/** Where a capture sits in the session's screen log, or null when it has no place there. */
const positionOf = (capture: ProofArtifactView["artifact"]["capture"]): string | null => {
  switch (capture._tag) {
    case "Screenshot":
      return `screen log · seq ${capture.moment.seq}`;
    case "Video":
      return `screen log · seq ${capture.span.fromSeq}–${capture.span.toSeq}`;
    case "Recording":
      return `screen log · seq ${capture.fromSeq}`;
    default:
      return null;
  }
};

function Thumbnail({ view }: { readonly view: ProofArtifactView }) {
  const capture = view.artifact.capture;
  if (view.mediaPath !== null && capture._tag === "Screenshot")
    return <img src={view.mediaPath} alt="" loading="lazy" className="size-full object-contain" />;
  if (view.mediaPath !== null && capture._tag === "Video")
    return (
      <video
        // Seeking just past the start paints a first frame in Safari too.
        src={`${view.mediaPath}#t=0.001`}
        muted
        playsInline
        preload="metadata"
        className="size-full object-contain"
      />
    );
  return capture._tag === "Recording" ? (
    <VideoIcon className="size-5 text-faint" />
  ) : (
    <ImageOffIcon className="size-5 text-faint" />
  );
}

/**
 * The proof artifacts attached to the change: screenshots, videos and recordings an agent captured
 * as it worked, each with where it sits in the session's screen log. Opening one shows it with its
 * caption, its source and how it was launched. Nothing shows when there are none.
 */
export function ChangeProofArtifacts({ changeId }: { readonly changeId: string }) {
  const trpc = useTRPC();
  const captures = useQuery(trpc.changes.proofArtifacts.queryOptions({ changeId }));
  const [openId, setOpenId] = useState<string | null>(null);
  if (captures.isPending || (captures.isSuccess && captures.data.length === 0)) return null;
  const open = captures.isSuccess
    ? captures.data.find((view) => view.artifact.id === openId)
    : undefined;
  return (
    <section aria-labelledby="proof-artifacts" className="grid gap-3 px-4 py-6 lg:px-[46px]">
      <h2 id="proof-artifacts" className="text-lead font-semibold">
        Proof artifacts
      </h2>
      {captures.isError ? (
        <QueryError
          error={captures.error}
          retry={() => void captures.refetch()}
          retrying={captures.isFetching}
        />
      ) : (
        <ul className="grid divide-y overflow-hidden rounded-xl border">
          {captures.data.map((view) => (
            <li key={view.artifact.id}>
              <button
                type="button"
                onClick={() => setOpenId(view.artifact.id)}
                className="flex w-full items-center gap-4 px-4 py-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-11"
              >
                <span
                  aria-hidden
                  className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted"
                >
                  <Thumbnail view={view} />
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-row font-medium">{view.artifact.title}</span>
                  <span className="text-meta break-words text-muted-foreground">{view.label}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
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
  const position = positionOf(capture);
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={artifact.title}
      description={<span className="font-mono text-meta">{label}</span>}
      size="md"
      footer={null}
    >
      {failed ? (
        <div role="status" className="grid justify-items-start gap-2 text-row">
          <p>This capture didn't load.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFailed(false);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : mediaPath !== null && capture._tag === "Screenshot" ? (
        <img
          key={attempt}
          src={mediaPath}
          alt={artifact.caption || artifact.title}
          onError={() => setFailed(true)}
          className="max-h-[60vh] w-full rounded-lg object-contain"
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
          className="max-h-[60vh] w-full rounded-lg"
        >
          {/* A screen capture has no speech to caption. */}
          <track kind="captions" />
        </video>
      ) : (
        <p className="text-row text-muted-foreground">
          {capture._tag === "NotCaptured" ? `Not captured · ${capture.reason}` : "Recording…"}
        </p>
      )}
      {artifact.caption === "" ? null : (
        <p className="text-row whitespace-pre-wrap">{artifact.caption}</p>
      )}
      {artifact.source._tag === "Unknown" ? (
        <p className="text-row text-muted-foreground">Source unknown · {artifact.source.reason}</p>
      ) : null}
      {artifact.sessionId === null ? (
        <p className="text-row text-muted-foreground">Its session was removed.</p>
      ) : (
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: artifact.sessionId }}
          className="text-row text-info hover:underline"
        >
          Open the session
        </Link>
      )}
      {artifact.launch === null ? null : (
        <div className="grid gap-1">
          <p className="text-meta text-muted-foreground">Launched with</p>
          <p className="font-mono text-2xs break-words whitespace-pre-wrap">{artifact.launch}</p>
        </div>
      )}
      {artifact.differences === null ? null : (
        <div className="grid gap-1">
          <p className="text-meta text-muted-foreground">Differences</p>
          <p className="text-row whitespace-pre-wrap">{artifact.differences}</p>
        </div>
      )}
      {position === null ? null : <p className="font-mono text-2xs text-faint">{position}</p>}
    </Overlay>
  );
}
