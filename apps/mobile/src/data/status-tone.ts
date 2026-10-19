import type { StatusTone } from "@/components/status";

export const ACTIVE = new Set(["starting", "running", "waiting", "idle"]);

/**
 * The tone a session status shows in. Only `waiting` asks the person; `idle` is live work that asks
 * nothing, a terminal agent at its prompt or Services holding the workspace (decided 2026-10-19).
 */
export const toneOf = (status: string): StatusTone =>
  status === "completed"
    ? "observed"
    : status === "failed"
      ? "breakage"
      : status === "waiting"
        ? "waiting"
        : ACTIVE.has(status)
          ? "live"
          : "pending";
