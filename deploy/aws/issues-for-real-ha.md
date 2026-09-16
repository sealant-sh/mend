# Blockers to real high availability on AWS

Updated 2026-09-16. This records what stops the AWS installation from running more than one copy of
each service, and what removing each blocker takes. It is a source review, not a tested design.
Every claim below is source-inferred unless marked observed. Nothing here authorizes infrastructure
changes.

See the [deployment overview](README.md), the [cost review](poc-cost-plans.md), the
[capture store ADR](../../docs/adr/0002-session-capture-store.md) and the
[public exposure](../../docs/reviews/public-exposure-findings.md) and
[team support](../../docs/reviews/team-support-findings.md) reviews. The
[workbench plan](../../MEND-AGENT-WORKBENCH-PLAN.md) remains the product source of truth.

## Summary

- The installation is single-instance by construction. Every Deployment runs one replica, and
  several of them cannot run two without code changes.
- A second node today shortens the outage after a node failure from the managed node group's
  replacement time to a pod reschedule. It removes no outage. The cost review says the same thing in
  its operations section.
- Two of the blockers are small and provider-specific. Two are engine changes that apply to every
  provider, including a later Cloudflare deployment. The engine change is smaller than it first
  looks, because the live data planes already avoid engine memory.
- Ownership of Mend, Sealant Core and sealantd is not a constraint. Items are sorted by what they
  technically block, not by which repository they land in.

## What runs where

| Workload          | Replicas | State that pins it to one process                                       |
| ----------------- | -------: | ----------------------------------------------------------------------- |
| Mend API          |        1 | Session channel registry, protocol pipes, boot pickup, background loops |
| Sealant API       |        1 | Module-level inference session map                                      |
| Sealant worker    |        1 | Reaper and reconciler timers                                            |
| Zot registry      |        1 | Single-attach gp3 volume                                                |
| Tailscale ingress |        1 | Proxy state Secret; documented as not node-HA                           |

Already safe to serve from any pod, and worth not breaking:

- The terminal route on the Mend API authenticates from Postgres, reads the process row and dials
  Sealant Core. Core's attach handler dials the VM's authenticated ingress endpoint per attach. No
  pod on that path holds a VM-initiated connection. The same is true of the service tunnel route.
- Per-worktree executor leases and epochs live in Postgres and are held by sealantd through its
  heartbeat, not by a Mend process. A Mend pod dying does not end a VM.
- Hot pool claims use `FOR UPDATE SKIP LOCKED` in one statement. Concurrent claimers cannot
  double-claim.
- Domain change events fan out through one Postgres `NOTIFY` channel, so any pod can serve the SSE
  stream.

## A. Session ownership in the Mend engine

The engine was written as one engine per machine. Four things in it assume that.

### A1. The session channel registry

When a VM's sealantd calls home through the internal NLB, the channel verifies the bearer token
against Postgres, then looks the session up in an in-memory registry. A session launched by another
pod answers `409 session channel: this session is not live on this Mend instance`. That lookup is
the whole affinity.

The route closures behind the registry are built from the capture store repo, the blob store, the
services repo, the git transport planner and the Sealant client. None of them read engine memory.
Replacing "is it in my registry" with "is it live in Postgres" makes every callback, including the
10-second `lease.heartbeat`, work on any pod. This is the smallest change on the list and on its own
it decouples VM survival from Mend pod survival.

### A2. Protocol pipe ownership

For `agent-protocol` sessions one pod holds the pipe to the codex app-server or claude stream-json
process in the VM, plus the adapter's correlation state. This is the one genuine owner relationship
in the engine.

Takeover already exists in single-process form. Restart policy v2 re-attaches to a surviving pipe by
process row and replays recorded output until dispatch passes the probe-time high water. What is
missing is the ownership record: an owner and a lease on the process row, and a reaper that lets
another pod rehydrate when the lease lapses. The mechanism exists; the bookkeeping does not.

### A3. Boot takes every live process

At start the engine lists every live process and supervises or rehydrates all of them. Two pods
would both claim the lot. This has to become a claim with `FOR UPDATE SKIP LOCKED`, which is how the
hot pool claim is already written. Same repository, same pattern.

### A4. Commands that need the pipe

Sending a turn, answering an approval and interrupting call the in-process adapter today. Under
ownership the pod that receives the request may not own the pipe. The clean shape is what follow-up
delivery already does: write the command to Postgres, notify, and let the owner dispatch. Turns and
approvals happen at human cadence, so a database hop there stays under the interactive latency bar.
Keystrokes never take this path; they stay on the direct terminal route.

### A5. Background loops

The 10-second capture lease reaper, the 20-second external-agent observer and the 10-minute hot pool
heartbeats run in every pod. The reaper and the pool claims are compare-and-swap in Postgres, so a
double run looks harmless. The observer has not been checked. The cheap fix is a Postgres advisory
lock so one pod runs each loop.

### What does not change

- Per-pod maps such as checkpoint semaphores and bridge contexts stay valid under ownership, because
  only the owner touches them.
- The Unix-socket registry exists only in co-located mode and is not used on Kubernetes.
- Hot pool claims are already multi-pod safe.

### Failure behaviour once A is done

A Mend pod dies. Its sessions' VMs keep running and keep heartbeating through whichever pod the NLB
picks. Terminals reconnect through any pod at once. Agent-protocol sessions go quiet until the
process lease lapses, then another pod claims them and rehydrates with replay. Turns queued in the
meantime dispatch after replay passes the high-water mark. Shell and PTY sessions have no pipe and
notice nothing.

### Order

A1 first. It is small and removes the 409 on its own, which lets two Mend pods coexist for shell
sessions. A2 and A3 together, since they are one feature. Then A4. A5 last.

## B. Sealant Core API in-process state

Core's API keeps interface-side inference sessions and their pending provider calls in a
module-level map, on purpose per its header comment. Same treatment as A2 in miniature: persist what
is durable, route or queue what is live. The workspace websocket handler is not affected; it opens
one daemon connection per attach for the socket's lifetime and holds nothing between attaches.

The endpoint token cache in the MicroVM adapter is a cache. Two pods minting tokens independently is
wasteful, not wrong.

## C. Sealant worker timers

Job consumption already shards across workers through pg-boss. The expiry reaper, image reaper,
orphaned-resource reconciler and exit reconciler are process timers and would run in every replica.
Move them to pg-boss singleton scheduled jobs, or make each tick idempotent. About a day of work.

Replacing pg-boss with an AWS queue does not help here. The timers are the problem, not the queue,
and Core also runs on the Hetzner cluster and in docker compose.

## D. The Mend project store volume

The 20 GiB claim holds bare repositories, the runner cache, references and the machine git key. Only
the API pod mounts it, ReadWriteOnce, which pins that pod to one node in one AZ. Sessions are not on
it; every session's work ships to the captures bucket.

Decision for AWS: EFS behind the EFS CSI add-on. The chart already states that a ReadWriteMany claim
mounts fine. This does not contradict the earlier "no shared filesystem" decision, which was about
MicroVMs mounting FSx as their working tree and paying a network round trip per file operation. Bare
repos and pack files are the workload NFS handles well.

Points that matter when doing it:

- Throughput mode must be Elastic. Bursting mode scales with stored bytes, and a 20 GB filesystem
  gets a baseline near 1 MB/s with a small credit bucket.
- Cost is small: Standard multi-AZ storage in Frankfurt is about $0.36 per GB-month, so roughly $7
  for the current size plus per-GB read and write charges. Do not use One Zone; AZ independence is
  the reason for the move.
- Git's ref locking works on NFSv4, so two pods fetching into the same bare repo are safe at the ref
  level. The runner cache writer is a per-process semaphore today and must become a cross-pod lock,
  either a Postgres advisory lock or a file lock on the mount. This is the same coordination A
  needs.
- The machine git key can ride along for now but belongs in Secrets Manager.
- Infrastructure additions: the filesystem, two mount targets, the CSI add-on with an IAM role like
  the existing EBS one, and NFS port 2049 from the node security group.
- If the review diff path proves slow on EFS, the fix is a local gp3 cache in front of it for hot
  repositories, not a return to a single disk.

A bucket-backed project store, where adopt and base-ref fetches run inside a VM that materializes
and uploads, remains the right shape for Cloudflare. It is not needed to reach HA on AWS.

## E. The Zot registry volume

The second single-attach disk, with the same pinning effect. Core's in-cluster BuildKit builder has
no credential path for ECR, so the worker's IAM role does not get BuildKit authenticated; the
[Kubernetes README](kubernetes/README.md) records this. Two ways out:

- Teach the BuildKit path to authenticate to ECR with a refreshed token. Adapter-level change in
  Core.
- For the MicroVM adapter, skip the in-cluster build and publish workspace images to ECR out of
  band, since AWS builds the MicroVM image from ECR anyway.

Either removes one pod and one claim.

## F. Topology after D and E

Once no volume pins a node, the node group can span both AZs with a minimum of two. The NLB and the
PlanetScale endpoint already span both private subnets, and the EKS control plane is multi-AZ by
construction. Remaining changes:

- A second NAT gateway and public IPv4 address for the second AZ.
- A higher Postgres connection limit or a pooler. Connection count now scales with pod count, and
  the POC hit the limit at one pod.

Monthly cost added on top of the fixed bill in the cost review, Frankfurt list prices:

| Addition                       | Monthly estimate |
| ------------------------------ | ---------------: |
| Second `m7g.large` node        |           $71.39 |
| Second NAT gateway and address |           $41.61 |
| EFS, current size, Elastic     |        $7 to $20 |
| **Total**                      | **$120 to $133** |

## G. Adjacent, not HA

- The Tailscale ingress proxy is a singleton and the access plan says two replicas on one node do
  not give node-level HA. A hosted product replaces it with a public load balancer and application
  authorization.
- Tenancy, enrollment, per-user credentials and stream revocation are the gate the reviews describe.
  Separate workstream; does not block A through F.

## Suggested order

1. C and E. Small, and they stop the worker and registry from being reasons to stay single-node.
2. D as EFS. Unpins the Mend API pod.
3. A1. Two Mend pods can coexist for shell sessions.
4. A2 and A3, then A4 and A5. Real failover for agent-protocol sessions.
5. B. Sealant API failover.
6. F. Two nodes across two AZs.

## Verification status

The findings come from reading Mend `packages/sessions`, `apps/api/src/routes`, `packages/db`, Core
`apps/api/src/routes/workspaces` and `packages/workspaces/src/runtime/microvm`, and the AWS
manifests in this directory, all on 2026-09-16. No multi-replica deployment has been run. Before
relying on any item above, reproduce the 409 from A1 with two Mend pods and confirm the terminal
route serves a session launched by the other pod.
