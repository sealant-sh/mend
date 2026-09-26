---
"@sealant/mend": minor
---

Organizations have their own defaults. An organization's owners set its workspace environment and
automation switches (background sessions, description and tour, fix suggestions, session naming,
landing) in Settings; every project in the organization inherits them unless it overrides a value,
and anything the organization leaves unset follows the instance. Members read the values that apply
and where each came from. Changes are recorded in the organization's audit log.

The instance's defaults stay the operator's, and Settings now shows their editors only to the
operator instead of showing them to everyone and refusing the save.
