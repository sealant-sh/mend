---
"@sealant/mend": patch
---

A fresh install on stock Ubuntu 24.04 now deals with the user namespace block before it's too late.
`mend server setup` reads the Docker host's kernel before it pulls the Mend image. When the kernel
refuses unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`, the default
since Ubuntu 23.10), setup says that no session can start and asks "Allow them now? [Y/n]". On a yes
it writes `/etc/sysctl.d/60-mend-rootless-docker.conf` on the Docker host and applies it through a
short privileged container on the Docker socket it already uses, then reads the kernel again. On a
no, without a terminal, or on a rootless daemon, it prints the command to run on the host, and
repeats it as its last line. `--allow-userns` and `--no-allow-userns` answer for a script.

On such a host, a launch now fails at once with doctor's words and the command, before any image is
built or any workspace is created. Before, it built for minutes and then failed with a raw
`docker exec … is not running`. The web shows the finding on the Now page and in the sidebar's
machine block, and a failed session's line sets the command apart.

When setup changes Mend's URL, it says so with the command every other CLI runs
(`mend login --url <new>`). When this machine's CLI points at the old URL and that URL no longer
answers, setup offers to point it at the new one; the sign-in carries over, since a device's token
is not bound to a URL. `mend doctor` recognises a CLI left on the old URL while the server on this
machine answers at its new one, and says so instead of "start the Mend server". A setup re-run says
to create the first account only while the instance has none. In the guided public HTTPS setup, a
domain that does not resolve from this machine makes Enter at "Apply?" change nothing, and setup
says why.
