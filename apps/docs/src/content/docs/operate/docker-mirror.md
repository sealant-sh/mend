---
title: Docker mirror
description:
  The pull-through cache of Docker Hub beside the Mend server, which every session's Docker daemon
  asks first.
sidebar:
  order: 5
---

A session's Docker service is a daemon of its own that starts with an empty image store. Without a
mirror, every `docker pull` and every `FROM` in a `docker build` goes to Docker Hub anonymously,
from the server's one address. Docker Hub limits anonymous pulls per address, and ten sessions that
each pull a few images can reach that limit (`toomanyrequests: unauthenticated pull rate limit`).
The Docker mirror keeps each layer it fetched and serves it again from the server's disk.

The mirror is the reference registry (`registry:3`) in proxy mode. The daemon checks every layer
against its digest, as it does from Docker Hub. Docker uses a mirror only for Docker Hub images;
`ghcr.io`, `quay.io` and other registries are reached directly.

## On the Docker install

`mend server setup` runs it as the `docker-mirror` service (container `mend-docker-mirror`), on by
default, and `mend server upgrade` adds it to an install from before it. The service publishes no
host port.

Each session's Docker daemon is started with `--registry-mirror=http://docker-mirror:5000`, and with
`--insecure-registry=docker-mirror:5000` so `docker build` reaches it over http too. The daemon
stays on its own network, because it answers without authentication on port 2375 and must not be
reachable from another session. Instead, Sealant connects the mirror's container to each session's
Docker network before the daemon starts, and disconnects it before that network is removed. This
needs a Sealant release with registry mirrors; the variables are listed in
[Server environment](/reference/server-environment/#package-and-image-mirrors).

```sh
mend server setup --no-docker-mirror   # turn it off; the next setup keeps it off
mend server setup --docker-mirror      # turn it on again
```

Its cache lives in the volume `mend_mend-docker-mirror`. The registry has no size cap. It removes
each layer and manifest seven days after it fetched it, and fetches it again on the next pull. A tag
is checked against Docker Hub on every pull, so `latest` follows upstream. When Docker Hub does not
answer, the copy already held is served.

`mend server status` reports what it observed:

```
docker mirror · running · 120 MiB cached · kept 7 days after each fetch · since 2026-10-10T08:00:00Z: layers 8 requested · 6 from the cache (75%) · manifests 6 · 3 from the cache · pulls from Docker Hub anonymously · observed
```

The counts are the registry's own, read from its metrics listener on the container's loopback, and
start again when the container restarts.

## A Docker Hub login

Anonymous by default. A Docker Hub account raises the pull limit for the mirror, and only for the
mirror. Pipe the account's access token on standard input:

```sh
printf %s "$DOCKER_HUB_TOKEN" | mend server setup --docker-hub-username mendbot --docker-hub-token-stdin
mend server setup --no-docker-hub-login   # back to anonymous
```

The token is kept in the install's `server.env`, private to the operator like the other server
secrets, and handed to the mirror's container alone. It never appears in a command line, in
`server.json`, in Mend's environment or in a session. Reruns and upgrades keep it until
`--no-docker-hub-login` or `--no-docker-mirror`.

## When the mirror is down

The daemon falls back to Docker Hub by itself. A mirror that does not answer costs one failed
request per pull, and the pull goes on from Docker Hub. The daemon logs
`Attempting next endpoint for pull after error`. A mirror container recreated while sessions run is
no longer on their networks; their pulls go to Docker Hub until they are relaunched.

## On Kubernetes

The chart runs it as an optional component:

```yaml
mirrors:
  docker:
    enabled: true
    ttl: 168h
    storage: 50Gi
    upstreamCredentials:
      existingSecret: "" # a Secret with keys username and password
```

It renders a Deployment (one replica, uid 1000), a ReadWriteOnce claim, a ClusterIP Service and a
NetworkPolicy that admits only the API tier and workspace Pods. On Kubernetes the daemon shares its
Pod's network, so point it at the Service in the Sealant chart:

```yaml
workspaces:
  docker:
    registryMirrors: [http://mend-docker-mirror.mend.svc:5000]
```

The Sealant chart's workspace egress policy must allow port 5000 to it; the Mend chart's notes print
the entry.

MicroVM workspaces run their own daemon and do not use the mirror.

## Exposure

The mirror publishes no port. Like Sealant and the database, it sits on the deployment's own
network, and the public exposure gate's `core-private` item names it when sessions are pointed at it
(see [Exposure](/operate/exposure/)).
