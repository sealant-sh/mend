# Changesets

Adding a CLI change to a release: run `pnpm changeset`, select `@sealant/mend`, choose the bump, and
describe it. Commit the generated `.changeset/*.md` file in the feature PR.

On merge to `main`, the Version workflow opens or updates a **Version Packages** PR that bumps the
CLI package and updates its changelog, and starts that PR's CI run so `checks` reports on it
(`docs/operations/ci.md`). Merge that PR, then push the matching `cli-vX.Y.Z` tag to trigger the
gated npm release. The tag remains the final version authority during publishing.
