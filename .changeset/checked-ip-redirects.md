---
"@sealant/mend": patch
---

Disable Git HTTP redirects for IP-literal repository URLs under the tenant source policy, so an
allowed address cannot redirect a clone to a destination the policy has not checked. Apply the
refusal to the exact checked URL as well, so inherited URL-specific Git settings cannot re-enable
redirects for that URL.
