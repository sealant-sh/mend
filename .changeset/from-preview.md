---
"@sealant/mend": minor
---

`mend server upgrade --from-preview` moves a server on a preview numbered before the next channel
(`0.36.0-preview.K`) to a next build or a new-style preview of the same version, once. Such a
preview sorts above both, so a plain upgrade refuses it as a downgrade; the refusal now names this
option. Before anything stops, the upgrade reads the migrations both databases applied and refuses,
naming them, when the target image lacks one, changed one (Sealant's, by hash), or would skip one (a
Mend migration below the highest id applied). A failure before the target starts recovers the
preview's own image, as any upgrade does.
