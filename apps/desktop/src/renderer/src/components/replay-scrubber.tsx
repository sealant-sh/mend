import type { CheckpointDto } from "#/lib/api";

/**
 * A settled session is not a dead tile (Figma 82:558): the record replays
 * like video, and the checkpoints are the ticks on the bar. Each tick is a
 * seek — the record view reads the process's output again from that
 * checkpoint's sequence (`GET /api/processes/:id/logs?from=<seq>`). The label
 * says exactly that, and the fact line says how the process ended.
 *
 * `face` switches between the byte replay and the conversation read from the
 * same record; null when the record holds no PTY output to replay.
 */
export function ReplayScrubber({
  checkpoints,
  from,
  onSeek,
  seekable = true,
  fact,
  face = null,
  onFace,
}: {
  readonly checkpoints: ReadonlyArray<CheckpointDto>;
  readonly from: string;
  readonly onSeek: (seq: string) => void;
  /** False while the conversation shows: the ticks seek the byte replay only. */
  readonly seekable?: boolean;
  /** How the process ended, e.g. "exited · observed". */
  readonly fact?: string;
  readonly face?: "replay" | "transcript" | null;
  readonly onFace?: (face: "replay" | "transcript") => void;
}) {
  const seqs = checkpoints.map((c) => Number(c.seq)).filter((n) => Number.isFinite(n));
  const max = Math.max(1, ...seqs);
  const current = Number(from);
  const position = Number.isFinite(current) ? Math.min(1, Math.max(0, current / max)) : 0;
  const index = checkpoints.findIndex((c) => c.seq === from);
  const label = !seekable
    ? face === null
      ? "no terminal output recorded to replay"
      : "conversation · read from the record"
    : checkpoints.length === 0
      ? "▶ replay · from seq 0 · no checkpoints"
      : index === -1
        ? `▶ replay · from seq ${from} · ${checkpoints.length} checkpoint${
            checkpoints.length === 1 ? "" : "s"
          }`
        : `▶ replay · from seq ${from} · checkpoint ${index} of ${checkpoints.length - 1}`;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-term-rule bg-term px-3 pt-2 pb-2.5">
      {seekable && (
        <div className="relative h-3.5 w-full" role="group" aria-label="Replay checkpoints">
          <div className="absolute top-1.5 right-0 left-0 h-0.5 bg-term-rule" />
          {checkpoints.map((checkpoint, i) => {
            const seq = Number(checkpoint.seq);
            const left = Number.isFinite(seq) ? (seq / max) * 100 : 0;
            return (
              <button
                key={checkpoint.id}
                type="button"
                title={`checkpoint ${i} · ${checkpoint.trigger} · seq ${checkpoint.seq}`}
                aria-label={`Replay from checkpoint ${i}, seq ${checkpoint.seq}`}
                onClick={() => onSeek(checkpoint.seq)}
                className="absolute top-0 h-3.5 w-3 -translate-x-1/2 cursor-pointer"
                style={{ left: `${left}%` }}
              >
                <span className="absolute top-[3px] left-1/2 h-2 w-0.5 -translate-x-1/2 bg-term-dim" />
              </button>
            );
          })}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0.5 size-2.5 -translate-x-1/2 rounded-full bg-term-accent"
            style={{ left: `${position * 100}%` }}
          />
        </div>
      )}
      <div className="flex items-center gap-3">
        <p className="min-w-0 truncate font-mono text-[11.5px] text-term-dim">{label}</p>
        <span className="flex-1" />
        {fact !== undefined && (
          <p className="shrink-0 font-mono text-[11.5px] text-term-fg">{fact}</p>
        )}
        {face !== null && onFace !== undefined && (
          <div role="group" aria-label="Record view" className="flex shrink-0 gap-0.5">
            {(["replay", "transcript"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={face === option}
                onClick={() => onFace(option)}
                className={`rounded px-1.5 py-0.5 font-mono text-[11.5px] transition-colors ${
                  face === option
                    ? "bg-term-rule text-term-fg"
                    : "text-term-faint hover:text-term-fg"
                }`}
              >
                {option === "replay" ? "terminal" : "conversation"}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
