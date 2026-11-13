---
"@sealant/mend": patch
---

Update the bundled Sealant Core SDK and images to 0.40.0-next.870.

- **Core says what each runtime supports.** Core can now list the runtimes it launches workspaces on
  and what each one can run. Mend does not read the list yet.
- **Some refusals arrive sooner.** A workspace Boat cannot start from (a cloned repository, or
  dotfiles sent with the create) is now refused when the workspace is created, not after the worker
  has picked it up. Mend already starts Boat workspaces from a capture, so no session changes.
- **Some refusal sentences changed.** Boat's sentence for Arch and Fedora now capitalizes the family
  name, and Core's Docker and Kubernetes refusals no longer name operator settings. Mend shows them
  as before.
