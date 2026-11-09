---
"@sealant/mend": patch
---

Connect the API keys the Anthropic Console creates today. The Console now issues keys linked to your
account and lists older keys as legacy; Mend refused every new key as "not an Anthropic API key".
Both kinds connect in Settings and with `mend connect claude --api-key`, and an Admin key is still
refused. Update the bundled Sealant Core SDK and images to 0.40.0-next.821.
