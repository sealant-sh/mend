------------------------- MODULE MCStandbyDiscard -------------------------
(* What check.sh hands TLC: the model, plus two restrictions used only by   *)
(* the diagnostic runs that say what the SLNT-823 finding depended on.      *)
EXTENDS StandbyDiscard

\* `retire` as one indivisible step: nothing commits between its snapshot
\* and its locked re-check. The finding survives it (mutant-no-reread-
\* atomic-retire), so it did not rest on Postgres's window inside one
\* statement.
RetireIsAtomic ==
  (\E d \in Slots : dpc[d] = "rapply") =>
    (\E d \in Slots : dpc[d] = "rapply" /\ dpc'[d] # "rapply")

\* No hot pool sweep at all. Without it the drain before SLNT-823 keeps the
\* promise (mutant-no-reread-no-sweep), so in one Mend process the finding
\* needed the sweep (see README.md, "What it depended on").
NoSweep == wpc' = "idle"
=============================================================================
