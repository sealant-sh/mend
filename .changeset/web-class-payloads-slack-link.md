---
"@sealant/mend": patch
---

Five web actions failed with "internal error": changing a project's visibility, turning shared
control on or off, changing a member's role, uploading files to a folder, and choosing a project's
folders. The web server passed plain objects where the API contract expects its request classes,
which Effect refuses to encode. It now builds the request classes.

The Slack link page confirmed nothing: its preview reached the API as a cookie-bearing POST without
an Origin and was refused. The preview now travels as a mutation, which carries the page's Origin.
Private Slack replies to a top-level mention (the link prompt, `settings` answers) were posted into
a thread nobody had opened, where Slack shows them nowhere; they now appear in the channel.
