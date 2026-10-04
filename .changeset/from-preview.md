---
"@sealant/mend": minor
---

`mend server upgrade --from-preview` moves a server on a preview numbered before the next channel
(`0.36.0-preview.K`) to a next build of the same version (`0.36.0-next.N`), once. Such a preview
sorts above every next build, so a plain upgrade refuses it as a downgrade; the refusal now names
this option. Before anything stops, the upgrade reads the migrations both databases applied and
refuses, naming them, when the target image does not carry one. A failure before the target starts
recovers the preview's own image, as any upgrade does.
