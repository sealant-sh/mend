---
"@sealant/mend": patch
---

`mend server setup` on a machine with two Docker engines, such as Docker Desktop and OrbStack on one
Mac, no longer installs a server it cannot reach. Before anything is pulled, setup checks that
Mend's web and SSH ports are free where they are to be published, and says what holds one that is
not: "127.0.0.1:3105, Mend's web port, is taken: another Mend, 0.27.4, answers there". On a terminal
it offers the next free port; with flags it refuses and names `--port` or `--ssh-port`. After
starting, it waits for health from the server it started, by version and by the instance id the
server now reports in `/api/health`, so another Mend answering on the same port is said as one
rather than read as this server's health.

`--context` and `--docker-socket` choose the Docker engine and answer no question:
`mend server setup --context orbstack` on a terminal now asks the questions and the Apply prompt,
and without a terminal a fresh install with only those flags is refused like one with none (`--yes`
takes the defaults). A fresh install without `--context` takes `DOCKER_CONTEXT`, as docker does; an
existing install stays on the context its data is on and says so.

When this machine's CLI points at another server, or where nothing answers, setup offers to point it
at the server it installed. A sign-in made at another server stays behind, and the offer leads with
no while that server still answers.

`mend doctor` reads the Docker daemon of the installed server's own context for its docker line, so
an OrbStack server is no longer told to restart Docker Desktop. When the CLI's loopback URL answers
with a server other than the one installed here, the server line says so and gives
`mend login --url`. The exposure line names the command to run (`mend server setup --edge <domain>`,
or `--url https://<origin>` behind HTTPS you run) instead of an internal setting.

The private-network question no longer offers Docker, OrbStack or vmnet bridge addresses, or network
addresses ending in .0. On the public HTTPS walk, workspace SSH defaults to this machine until you
state that you checked it from outside, so the defaults no longer undo each other, and the question
about stating what you checked says what it is for.
