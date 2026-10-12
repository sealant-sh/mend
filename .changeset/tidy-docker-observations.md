---
"@sealant/mend": patch
---

Keep the server identity and prepared generations when Docker discovery or ownership inspection
fails during uninstall. Recheck the confirmed identity and generation under the store lock before
removal, and record pending resources with their Docker context and owner before teardown, so
interrupted cleanup can be retried on the same context.

Uninstall now retains and refuses nonempty retry records from older versions that contain only
resource names. Operators must verify their original Docker context and installation identity before
repairing those records; uninstall does not guess their provenance. Empty older records remain
valid.
