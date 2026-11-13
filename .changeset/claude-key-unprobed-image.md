---
"@sealant/mend": patch
---

A person whose default Claude login is an API key can start their first session on a newly built
image. Until Mend has checked whether an image runs per-person users, a launch ran with everyone's
logins in one shared home; sealant never places a key there, so the launch was refused with
`Your Claude login is an API key. This workspace keeps everyone's logins in one shared home…`, and
the check that would have answered for the image runs only in a workspace that exists, so every
retry was refused the same way until someone else started a session on that image. While an image's
answer is unknown, a Claude session whose launcher's default login is a key now launches per person,
with the key in their own home, and that launch answers for the image. Only an image that cannot run
per-person users falls back to one shared home, where the refusal and its words still apply. Other
launches are unchanged.
