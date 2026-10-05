import { OnOffSwitch } from "#/components/on-off-switch";
import type { ProjectInstallDetectionDto } from "#/lib/api";

/**
 * The "Dependencies" card on a project's Setup page, as a view of its inputs: the "Automatic
 * install" switch, what a launch would run, and the optional custom command (ADR-0002 decisions
 * 2 and 9). On, Mend runs the custom command, else the one detected from the lockfile, in a
 * workspace whose saved state and shared cache have no dependency tree for its platform, and in
 * the install it launches itself to fill the shared cache. Off, it runs none; a tree already
 * saved or cached is restored either way. Only capture mode installs: a co-located worktree keeps
 * its own dependencies, so the card says so there.
 */
export function AutomaticInstallView({
  installEnabled,
  installCommand,
  captured,
  detection,
  draft,
  busy,
  error,
  onEnabled,
  onDraft,
  onSave,
}: {
  readonly installEnabled: boolean;
  readonly installCommand: string | null;
  /** Whether this server runs sessions in capture mode, the only mode that installs. */
  readonly captured: boolean;
  /** What a launch would detect; undefined while it is asked for, or when asking failed. */
  readonly detection: ProjectInstallDetectionDto | undefined;
  readonly draft: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onEnabled: (installEnabled: boolean) => void;
  readonly onDraft: (draft: string) => void;
  readonly onSave: () => void;
}) {
  const current = installCommand ?? "";
  const dirty = draft.trim() !== current;
  return (
    <section id="install-command" className="project-setup-card">
      <h2 className="font-sans text-sm font-semibold">Dependencies</h2>
      {captured ? (
        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          On, Mend installs dependencies before the agent starts when the saved state has none for
          the workspace&apos;s platform, and fills this project&apos;s shared cache, which standby
          workspaces start from. Off, Mend runs no install; an agent can install by hand. A tree
          already saved or cached is restored either way.
        </p>
      ) : (
        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          Capture mode only. This server runs sessions co-located with the store, where a worktree
          keeps its own dependencies and Mend runs no install. The setting is kept for capture mode.
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 font-mono text-xs text-ink-2">automatic install</p>
        <OnOffSwitch value={installEnabled} busy={busy} onChange={onEnabled} />
      </div>
      {installEnabled ? (
        <>
          <p className="mt-2 font-mono text-xs text-ink-2">
            {current !== "" ? (
              <>
                runs · {current}
                <span className="text-faint"> · custom</span>
              </>
            ) : (
              <DetectedInstall detection={detection} />
            )}
          </p>
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && dirty) onSave();
            }}
          >
            <input
              type="text"
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              placeholder="custom command (optional)"
              aria-label="Custom install command"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
            />
            <button
              type="submit"
              disabled={busy || !dirty}
              className="h-[26px] rounded-lg border border-border bg-card px-2.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              save
            </button>
          </form>
          <p className="mt-2 text-xs leading-relaxed text-faint">
            A custom command replaces the detected one. Empty: detected.
          </p>
        </>
      ) : (
        <p className="mt-2 font-mono text-xs text-ink-2">
          off · no install runs, in sessions or for the shared cache
          {current === "" ? null : <span className="text-faint"> · custom command kept</span>}
        </p>
      )}
      {error !== null && (
        <p className="mt-2 border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">{error}</p>
      )}
    </section>
  );
}

/** What a launch with no custom command would run, as read from the ref it bases on. */
function DetectedInstall({
  detection,
}: {
  readonly detection: ProjectInstallDetectionDto | undefined;
}) {
  if (detection === undefined) return <>detected from the lockfile at launch</>;
  if (!detection.read) {
    return (
      <>
        not read<span className="text-faint"> · detected from the lockfile at launch</span>
      </>
    );
  }
  if (detection.command === null || detection.from === null) {
    return (
      <>
        no lockfile recognised on {detection.ref}
        <span className="text-faint"> · detected again at launch</span>
      </>
    );
  }
  return (
    <>
      detected · <span className="text-foreground">{detection.command}</span>
      <span className="text-faint">
        {" "}
        · from {detection.from} on {detection.ref}
      </span>
    </>
  );
}
