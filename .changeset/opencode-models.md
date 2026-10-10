---
"@sealant/mend": patch
---

opencode has models to pick. The server's catalog lists the Codex models for opencode as it names
them (`openai/gpt-6.1-sol` and the rest, through your ChatGPT login), so the web composer, VS Code
and `mend models` offer them, and a session records the one it was started on. None is the default:
a launch that names no model sends none, so the model in your project's or your own opencode config
still decides, then the one opencode last used. An operator's own opencode rows are kept, and a row
an operator flags as the default is the default. In VS Code, opencode's model pick leads with
"opencode's own choice", so a plain Enter sends no model.
