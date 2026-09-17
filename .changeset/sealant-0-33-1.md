---
"@sealant/mend": patch
---

Runs on Sealant 0.33.1, which bakes sealantd 0.16.0 (sealant-sh/sealant#249). That is the daemon
release Mend's capture channel now expects: every PUT URL the executor mints is bound to the length
the PUT sends, which is what `MEND_CAPTURE_REQUIRE_SIZES=true` refuses uploads without, and
`plan.get`'s `sources` are laid down beside the worktree, which is how a project's folders and
reference repositories reach a captured workspace.

`@sealant/sdk` and `@sealant/api-contracts` move to 0.33.1, and the bundled server image pins the
0.33.1 API, worker and ssh-gateway digests.
