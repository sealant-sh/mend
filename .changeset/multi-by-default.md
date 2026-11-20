---
"@sealant/mend": minor
---

A new install serves several organizations, and only an operator creates them.

- `mend server setup` on a fresh install writes `MEND_TENANCY=multi` (with
  `MEND_CAPTURE_REQUIRE_SIZES=true`). `--tenancy single` still declares one organization. An install
  that never declared tenancy stays `single` across reruns and upgrades. The Nix module, with
  `tenancy` unset, picks `multi` on its first start when the install has no data and runs this
  version or later, and `single` otherwise, and keeps that choice in `<stateDir>/tenancy`.
- Several organizations on one Mend belong to one business. The multi mode gate no longer asks for
  `MEND_SOURCE_POLICY=tenant`, so Mend's own git still reaches a Git server on your LAN or tailnet,
  and `--tenancy multi` no longer writes it. A `public` exposure still needs it, and
  `--exposure public` still writes it.
- A first start with no account yet is no longer refused in `multi` for having no operator: the
  first account to register becomes the operator.
- `MEND_ORGANIZATION_CREATION` defaults to `operator`. An operator sees "Create organization…" in
  the web app's organization switcher and owns what they create; everyone else is refused, as
  before. `anyone` lets every signed-in person create one. `GET /api/organization` gains
  `organizationCreation`, and Settings → Server names it.
