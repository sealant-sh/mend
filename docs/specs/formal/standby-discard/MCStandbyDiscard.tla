------------------------- MODULE MCStandbyDiscard -------------------------
(* What check.sh hands TLC: the model, plus two restrictions used only by   *)
(* the diagnostic runs that say what the finding depends on.                *)
EXTENDS StandbyDiscard

\* `retire` as one indivisible step: nothing commits between its snapshot
\* and its locked re-check. The finding survives it, so the finding does not
\* rest on Postgres's window inside one statement.
RetireIsAtomic ==
  (\E d \in Slots : dpc[d] = "rapply") =>
    (\E d \in Slots : dpc[d] = "rapply" /\ dpc'[d] # "rapply")

\* No hot pool sweep at all. The promise holds then, so in one Mend process
\* the finding needs the sweep (see README.md, "What it depends on").
NoSweep == wpc' = "idle"
=============================================================================
