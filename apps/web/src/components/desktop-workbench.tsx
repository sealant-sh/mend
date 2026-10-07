import { Button } from "@mend/ui/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { desktopCommand, readDesktopState } from "#/lib/desktop";

/** Live pixels, a dedicated pilot, and its observed artifacts in one viewport. */
export function DesktopWorkbench({ baseUrl }: { readonly baseUrl: string }) {
  const state = useQuery({
    queryKey: ["desktop", baseUrl],
    queryFn: () => readDesktopState(baseUrl),
    refetchInterval: 1000,
    retry: false,
  });
  const [harness, setHarness] = useState<"claude" | "codex">("codex");
  const [mode, setMode] = useState<"actions" | "code">("actions");
  const [model, setModel] = useState("");
  const [goal, setGoal] = useState(
    "Open http://127.0.0.1:6090/demo. Make the counter read 5, enter Mend in the name field, and report the greeting you observe.",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const observed = state.data;
  const active = observed?.active ?? null;
  const act = async (command: "pilot" | "cancel" | "takeover" | "release") => {
    setPending(true);
    setError(null);
    try {
      await desktopCommand(
        baseUrl,
        command,
        command === "pilot" ? { harness, mode, model, goal } : null,
      );
      await state.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Desktop operation failed.");
    } finally {
      setPending(false);
    }
  };
  const field =
    "w-full rounded-xl border border-input bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="overflow-hidden rounded-2xl bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="font-mono text-xs text-muted-foreground">
            {observed?.display ?? "Connecting to desktop…"}
          </p>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">
              {active
                ? `${active.harness} · ${active.mode} · ${active.actions} calls`
                : observed?.humanControl
                  ? "You control input"
                  : "Watching"}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !observed}
              onClick={() => void act(observed?.humanControl ? "release" : "takeover")}
            >
              {observed?.humanControl
                ? "Release control"
                : active
                  ? "Take control · stop pilot"
                  : "Take control"}
            </Button>
          </div>
        </div>
        <iframe
          title="Agent desktop"
          src={`${baseUrl}/viewer`}
          className="aspect-[1440/900] w-full border-0"
        />
      </div>
      <div className="contents">
        <form
          className="space-y-4 rounded-2xl bg-card p-5 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void act("pilot");
          }}
        >
          <h2 className="text-base font-medium">Pilot the desktop</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5 text-xs text-muted-foreground">
              Agent
              <select
                aria-label="Pilot agent"
                className={field}
                value={harness}
                disabled={pending || active !== null}
                onChange={(event) => {
                  if (event.target.value === "claude" || event.target.value === "codex") {
                    setHarness(event.target.value);
                    setModel("");
                  }
                }}
              >
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              Execution
              <select
                aria-label="Execution style"
                className={field}
                value={mode}
                disabled={pending || active !== null}
                onChange={(event) => {
                  if (event.target.value === "actions" || event.target.value === "code")
                    setMode(event.target.value);
                }}
              >
                <option value="actions">Actions</option>
                <option value="code">Code</option>
              </select>
            </label>
          </div>
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            Model
            <input
              className={field}
              value={model}
              disabled={pending || active !== null}
              placeholder="Agent's default"
              onChange={(event) => setModel(event.target.value)}
              maxLength={100}
            />
          </label>
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            What should it do?
            <textarea
              className={`${field} min-h-36 resize-y leading-relaxed`}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              maxLength={8000}
              required
              disabled={pending || active !== null}
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {mode === "actions"
              ? "The agent chooses clicks and keys from screenshots."
              : "The agent writes short JavaScript batches, then checks the screen."}{" "}
            Recording starts with the pilot. Each run has a five-minute limit.
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || active !== null || !observed}>
              Start pilot
            </Button>
            {active ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void act("cancel")}
              >
                Stop pilot
              </Button>
            ) : null}
          </div>
          {error || state.error ? (
            <p role="alert" className="text-sm text-danger">
              {error ?? state.error?.message}
            </p>
          ) : null}
        </form>
        <section className="col-span-full grid min-w-0 gap-4 lg:grid-cols-2">
          <h2 className="col-span-full text-base font-medium">Recorded observations</h2>
          {!observed?.runs.length ? (
            <p className="text-sm text-muted-foreground">
              Run the pilot to collect a recording, screenshot and action log.
            </p>
          ) : null}
          {observed?.runs.map((run) => (
            <article key={run.id} className="rounded-2xl bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-xs text-muted-foreground">
                  {run.harness} · {run.mode} · {run.actions} calls
                </p>
                <p
                  className={`font-mono text-xs ${run.status === "completed" ? "text-success" : run.status === "failed" ? "text-danger" : "text-muted-foreground"}`}
                >
                  {run.status} · observed
                </p>
              </div>
              <p className="mt-3 text-sm leading-relaxed">{run.goal}</p>
              {run.status === "running" ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  The pilot is using the desktop above. Recording will appear when it stops.
                </p>
              ) : (
                <>
                  <video
                    controls
                    preload="metadata"
                    poster={`${baseUrl}/runs/${run.id}/final.png`}
                    src={`${baseUrl}/runs/${run.id}/recording.mp4`}
                    className="mt-4 aspect-[1440/900] w-full rounded-xl bg-secondary"
                  />
                  <p className="mt-4 max-h-64 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2">
                    {run.result}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-4 text-xs text-info">
                    <a href={`${baseUrl}/runs/${run.id}/recording.mp4`} download>
                      Video
                    </a>
                    <a
                      href={`${baseUrl}/runs/${run.id}/final.png`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Final screenshot
                    </a>
                    <a
                      href={`${baseUrl}/runs/${run.id}/actions.jsonl`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Action log
                    </a>
                  </div>
                </>
              )}
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
