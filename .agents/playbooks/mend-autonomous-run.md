---
extends: autonomous-run
when: Any long autonomous loop in Mend, such as review-and-fix over a PR.
---

# Mend autonomous runs

- **In** "State the exit condition as a checkable predicate before the first iteration" "Review
  until clean" is not a predicate. Name the reviewers, the number of rounds, and which findings
  block, so that a count can say when the run ends.
- **In** "Stop when the predicate is met." Only the owner ends a run before its predicate is met. A
  run that cannot reach its predicate reports where it stopped and what blocks it, and keeps the
  predicate as stated.
