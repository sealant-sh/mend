---
"@sealant/mend": minor
---

On a server running `MEND_TENANCY=multi`, anyone signed in can now create an organization with
`POST /api/account/organizations` and a `name`. They become its owner and only member, and the
sign-in that asked switches to it. The organization starts with no projects, and its settings,
runtime and starting image are the server's until an owner sets its own.

- A refused name answers with its own tag: `OrganizationNameTaken` (409, any letter case, across the
  server), `OrganizationNameEmpty` or `OrganizationNameNotAllowed` (422, too long or a control
  character).
- `GET /api/organization` gains `canCreateOrganizations`, so a client offers creating only when this
  sign-in may. An access key never may.
- An operator who wants to keep creating organizations to themselves sets
  `MEND_ORGANIZATION_CREATION=operator` (default `anyone`). People are then refused, and
  `mend operator org create` works as before.
- A single-tenant server is unchanged: nobody creates a second organization.
