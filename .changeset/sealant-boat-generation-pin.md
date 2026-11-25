---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.940. The workspace runtime (sealantd
0.21.0-next.209) does not change.

- **Boat sessions start again.** Since 25 Nov 2026, Boat adds a `_generation` parameter to the URL
  it gives for a VM's control port. sealant refused that URL, so every Boat session failed as it
  launched, with `launch-held; diagnostic {"step":"host-agent",…,"status":null,"causeClass":null}`,
  and its VM was deleted. sealant now accepts the parameter, and Boat sessions start and run as
  before.
