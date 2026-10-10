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

Its cache lives in the volume `mend_mend-docker-mirror`. The registry has no size cap of its own, so
it runs under a guard (`docker-mirror-guard.sh`, its entrypoint) that checks every 30 seconds:

- **The cap.** Over `--docker-mirror-max-size` (default `20g`), the guard stops the registry, clears
  the cache and starts it again. The next pulls fill it from Docker Hub.
- **The floor.** With less than 5 GiB free on the disk the volume lives on, it stops the registry
  and clears the cache, including one left over from before a restart, and keeps the registry
  stopped. Meanwhile session daemons pull from Docker Hub directly, as they do when the mirror is
  down. On the first check with 5 GiB free again, it starts the registry with an empty cache.

```sh
mend server setup --docker-mirror-max-size 40g   # a larger cap
```

Between those, the registry expires content on its own schedule. Seven days after it fetched a
layer, it deletes the layer's data and fetches it again on the next pull. A manifest expires on the
same schedule, but only its link to the repository goes: the manifest's own bytes and the tag links
stay on the volume until the cap or the floor clears it. A tag is checked against Docker Hub on
every pull, so `latest` follows upstream. When Docker Hub does not answer, the copy already held is
served.

To clear the cache by hand, which holds only copies of Docker Hub content:

```sh
mend server setup --no-docker-mirror                            # removes the container, keeps the volume
docker --context <context> volume rm mend_mend-docker-mirror    # the cache itself
mend server setup --docker-mirror                               # a new, empty cache
```

Sessions running while it is off pull from Docker Hub; relaunch them to use the new mirror.

`mend server status` reports what it observed:

```
docker mirror · running · 120 MiB cached of 20 GiB · 412 GiB free on its disk · layers evicted 7 days after each fetch · since 2026-10-10T08:00:00Z: layers 8 requested · 6 from the cache (75%) · manifests 6 · 3 from the cache · pulls from Docker Hub anonymously · observed
```

When the guard has paused it for want of space, status says so instead. After clearing, the guard
looks at the cache again, and status reports what it found: `no cache held`, or
`its cache could not be cleared` when a file there could not be removed.

```
docker mirror · paused by its disk guard · 3.0 GiB free on its disk, below 5.0 GiB · no cache held · session Docker daemons pull from Docker Hub directly until there is room · observed
```

The counts are the registry's own, read from its metrics listener on the container's loopback, and
start again when the container restarts.

## A Docker Hub login

Anonymous by default. A Docker Hub account raises the pull limit for the mirror, and only for the
mirror.

The mirror has no login of its own. Every session that reaches it can pull whatever the mirror's
token can read, and that includes private repositories if the token can read them. Keeping the token
secret does not limit what the mirror serves. So give it a token that can read public images and
nothing else: a Docker Hub personal access token whose access permission is **Public Repo
Read-only**, ideally on an account that holds no private repositories. Never use an organization's
or a person's everyday token.

Pipe the token on standard input, and state its scope with `--docker-hub-public-only`. Setup refuses
a login without it, because Mend cannot check a token's scope:

```sh
printf %s "$DOCKER_HUB_TOKEN" | mend server setup --docker-hub-username mendbot --docker-hub-token-stdin --docker-hub-public-only
mend server setup --no-docker-hub-login   # back to anonymous
```

The token is kept in the install's `server.env`, private to the operator like the other server
secrets, and handed to the mirror's container alone. It never appears in a command line, in
`server.json`, in Mend's environment or in a session. Reruns and upgrades keep it until
`--no-docker-hub-login` or `--no-docker-mirror`. `mend server status` names the account and repeats
that every session can pull what its token can read.

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
    maxSize: 40g # the guard's cap; keep it below the claim
    storage: 50Gi
    upstreamCredentials:
      existingSecret: "" # a Secret with keys username and password
      publicReadOnly: false # true states the token is scoped Public Repo Read-only
```

A login here carries the same consequence as on the Docker install: every admitted workspace can
pull whatever the token can read. The chart refuses `existingSecret` unless `publicReadOnly: true`
states that its token's access permission is Public Repo Read-only.

The chart runs the same guard, with `mirrors.docker.maxSize` and `mirrors.minFree` (5g); below the
floor the Pod is not ready and workspaces pull from Docker Hub. It renders a Deployment (one
replica, uid 1000), a ReadWriteOnce claim, a ClusterIP Service and a NetworkPolicy that admits
workspace Pods only. On Kubernetes the daemon shares its Pod's network, so point it at the Service
in the Sealant chart:

```yaml
workspaces:
  docker:
    registryMirrors: [http://mend-docker-mirror.mend.svc:5000]
```

The Sealant chart's workspace egress policy must allow port 5000 to it; the Mend chart's notes print
the entry. To clear the cache, scale the Deployment to zero, delete its claim, and let the chart
make a new one:

```sh
kubectl -n mend scale deployment/mend-docker-mirror --replicas=0
kubectl -n mend delete pvc mend-docker-mirror
helm upgrade mend deploy/helm/mend -n mend --reuse-values
kubectl -n mend scale deployment/mend-docker-mirror --replicas=1
```

MicroVM workspaces run their own daemon and do not use the mirror.

## Exposure

The mirror publishes no port. Like Sealant and the database, it sits on the deployment's own
network, and the public exposure gate's `core-private` item names it when sessions are pointed at it
(see [Exposure](/operate/exposure/)).
