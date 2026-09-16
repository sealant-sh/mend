---
"@sealant/mend": patch
---

Adopt Sealant 0.33.0 in the public SDK, bundled service images and AWS deployment templates. Pin the
AWS workspace-image recipe to the same release and retain the platform's runtime-specific Docker
errors.

AWS workspace Docker remains opt-in and requires a separate Docker-capable image with matching
configuration on API and worker. Updating Mend does not install Docker into retained workspaces or
change a running AWS deployment. The matching `sealantctl` packaging requirement still applies.
