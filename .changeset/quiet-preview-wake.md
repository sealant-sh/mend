---
"@sealant/mend": minor
---

Stop previews after 30 minutes without admitted application requests and show why they stopped.
Opening an idle preview shares one start across visitors, runs recipe setup and dependencies as the
last starter, and holds the request until ready. Configure the idle duration with MEND_PREVIEW_IDLE.
A person's Stop stays in force. Co-located workspaces wake without an agent. When a capture-backed
workspace has ended, the preview page asks you to resume the session in Mend.
