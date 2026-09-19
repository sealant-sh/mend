# The SSH git remote for packaged acceptance (scripts/packaged-git-access-acceptance.mjs): what a
# git host is to Mend. One `git` account, public keys only, git-shell, and an sshd that logs the
# fingerprint it accepted, so the run can prove which signer authenticated, not only that a clone
# succeeded. No host ports are published; it is reached by name on the installation's network.
FROM alpine:3.22
RUN apk add --no-cache git openssh-server \
  && adduser -D -s /usr/bin/git-shell git \
  && echo 'git:*' | chpasswd -e \
  && mkdir -p /srv/git /etc/ssh/authorized \
  && chown git:git /srv/git \
  && touch /etc/ssh/authorized/git
COPY sshd_config /etc/ssh/sshd_config
EXPOSE 2222
ENTRYPOINT ["/bin/sh", "-c", "ssh-keygen -A >/dev/null && exec /usr/sbin/sshd -D -e"]
