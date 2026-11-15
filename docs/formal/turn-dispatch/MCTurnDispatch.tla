--------------------------- MODULE MCTurnDispatch ---------------------------
(* TurnDispatch plus the restrictions check.sh's diagnostic rows use.     *)
EXTENDS TurnDispatch, TLC

\* While a dispatch is Writing, the host reads no turn/started but the one for its own message:
\* the schedule SLNT-466 needs. The other turn can be one Codex started on its own (even just
\* before the write), an earlier message Codex took late after its send failed, or any turn on an
\* adapter made by rehydrate, which reports every turn as turn.started.
NoOtherTurnSeenDuringSend ==
  ~(/\ out /= <<>> /\ out' = Tail(out)
    /\ Head(out).k = "started" /\ Head(out).id[1] /= dt
    /\ Writing)

\* No retry with the same launch correlation id.
NoRetry == retried' = retried

\* No Mend restart and no retry: SLNT-466's own schedule, a send that times out.
NoRestartNoRetry == restarted' = restarted /\ NoRetry

Symmetry == Permutations(Turns)
=============================================================================
