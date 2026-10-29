---
"@sealant/mend": minor
---

`mend server setup --preview-domain <domain> --preview-certificate <file> --preview-key <file>` has
the edge serve live previews, each at `https://<label>.<domain>`, on a registrable domain other than
Mend's. The packaged edge cannot issue a wildcard certificate, so you supply one for `*.<domain>`
and its key, issued elsewhere over DNS-01. Each run checks that the certificate names `*.<domain>`,
that the key is its own and that the edge's own container loads them, then copies both into the
install; to serve a renewed certificate, replace the files and run `mend server setup --yes`. Setup
refuses a domain that is Mend's host, sits above or below it, or shares its registrable domain, and
says whether the preview gateway answered and where a name under the domain resolves. The gateway's
port is published on 127.0.0.1 only. The edge logs no path, query or `Referer` for preview hosts,
because the sign-in exchange carries a ticket in its query. `mend operator exposure` lists the new
`preview-gateway` item; state what you checked from another network with
`--declare preview-gateway`, which a public install needs before setup turns previews on.
`--no-preview-domain` turns previews off.
