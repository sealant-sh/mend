---
"@sealant/mend": minor
---

A project's workspace image is now its own copy. When a project is created it copies its
organization's starting image, and from then on the image is the project's: changing the
organization's starting image changes the projects created after it, not the ones that exist. An
organization's starting image is likewise its own copy of the server's, taken when the organization
is created.

- On upgrade, every project and organization that followed a level above keeps what it resolved to
  then, as its own copy: no session's image changes. A Boat server's organizations keep Ubuntu.
- A project's `workspaceImage` and an organization's `workspaceImage` are never `null` in the API.
- `PUT /api/projects/:id/workspace-image` with `{ "workspaceImage": null }`, which older clients
  send for "use the default", saves a copy of the organization's starting image as it is now. The
  organization's `PUT /api/organization/settings/workspace-environment` (and
  `/organization/settings`) with a `null` image saves a copy of the server's.
- Changing an organization's starting image no longer rebuilds any project's ready workspaces.
- In the web app, a project's image always reads `set for <project>`, and `reset` copies the
  organization's starting image. The organization's environment page has no "Follow the instance".
