---
"@sealant/mend": patch
---

Capture mode: nothing an executor holds is let go on an empty queue alone.

- Every drain (stop, idle stop, relaunch, replacement) asks for a final flush and counts only the
  executor's `complete: true` as saved. Until the SDK carries it, a drain keeps its workspace and
  reads `not saved · final flush not reported · workspace kept`; an incomplete flush names
  sealantd's reason. Nothing is started, joined or resumed in an executor sent a final flush.
- The lead before a stated cap grows with what is pending at the executor's observed throughput.
- A lapsed lease is not an end: another session is refused until the platform confirms the holder
  ended, and a release now clears the holder.
- Worktree and project removal wait for drains, kept workspaces, unended executors and held leases;
  the session that owns an executor stays while another session works in it.
- Every landing (Land panel, Slack, `mend land`, a completed turn) checkpoints only once the
  captures caught up; unknown is not caught up, and the landing reads exactly that capture.
- A turn asked after the idle stop's claim is refused instead of queued against a stopped agent.
- A relaunch interrupted by a restart finishes: drain, terminate, then the launch it was asked for,
  opening prompt included, exactly once (migration 0077).
- The owner's stop during a replacement wins: the executor saves and ends, and no new one starts.
