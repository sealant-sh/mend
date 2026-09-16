# AWS Mend access plan

Status: historical plan, 2026-09-16. No infrastructure change was made while publishing this plan.
The owner subsequently approved a private Tailscale rollout; see the separate
[deployment record](aws-access-deployment.md) for installed versions, observed checks and remaining
acceptance. The gate statuses below describe the planning baseline, not current deployment status.
The owner-only pilot does not establish that every gate has passed or authorize public/team access.

## Decision and evidence

Keep the current private operator route unchanged now. Do not add a public domain, Internet
listener, teammate access, or Tailscale enrollment as part of this work.

For the next approved rollout, recommend one owner-only tailnet HTTPS endpoint for Mend, backed by a
standalone Tailscale Kubernetes Operator Ingress. Keep the Kubernetes API and every platform service
outside this user-access path. This removes everyday port-forwarding without changing who is trusted
to operate the instance. Teammates require a later authorization and revocation release.

| Endpoint or audience                          | Decision today                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Existing private operator access              | Preserve unchanged.                                                                    |
| Mend over a new tailnet endpoint              | Proposed next method, owner only; blocked on gates G1-G5 below.                        |
| Teammates on that endpoint                    | No-go until G6 passes. The reviewed team snapshot is not ready to ship.                |
| Mend on the public Internet                   | No-go for 0.27.5 and reviewed main. G7 requires a separate decision after remediation. |
| Core API on the public Internet               | Separate no-go for 0.32.0. Mend exposure approval would not authorize Core exposure.   |
| Core API for ordinary tailnet users           | No-go. Keep Core behind the Mend backend's service identity.                           |
| Registry, DB, Kubernetes API, executor daemon | No new ordinary-user exposure under either access method.                              |

Evidence labels in this document mean:

- Observed: files or official documentation were read in this review. Deployment observations
  attributed to the AWS deployment record were not independently repeated against AWS.
- Reproduced: a local, synthetic check ran in the access-plan worktree.
- Source-inferred: the implementation implies the behavior, but this review did not exercise it
  live.
- Proposed: intended configuration or acceptance work, not installed behavior.
- Blocked: an unmet requirement prevents rollout or a stronger conclusion.

Observed source baseline is Mend `6a2c50ec4f8fa33c287ef7945bb36b2346ae5924`. AWS source was read
from `feat/aws-capture-deploy`, PR [#258](https://github.com/sealant-sh/mend/pull/258), recorded
deployment commit `dfef71f3d`. Its existing local changes were not edited. Official Tailscale and
Let's Encrypt references were fetched on 2026-09-16; links are collected at the end. Documentation
verification is not a live Tailscale test. Companion reviews inspected deployed Mend 0.27.5, Core
0.32.0 and an isolated unfinished team snapshot based before the capture-store changes. Their local
test results are reported evidence, not tests repeated by this documentation pass. Sensitive finding
details stay in the private handoff; this document records defensive requirements only.

### Release and rollout gates

Every gate below is blocked or unverified today. A passing source test is not evidence that a fix
has reached the cluster. Record the exact release, test result and operator approval for each gate.

| Gate | Scope                              | Evidence needed before proceeding                                                                                                                                                                                                                                                                                 |
| ---- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | Owner-only perimeter               | Approved tailnet, named owner/devices, billing, CT/name consent, maintenance window, exact chart/image pins; complete policy denies everyone else and excludes administrative services.                                                                                                                           |
| G2   | Mend origin and enrollment         | Chart regression proves matching `APP_URL`/alternate origins on API and web without backend secrets in web. Deliberate bootstrap/closed registration and account inventory. Do not invent an unsupported signup-disable environment variable.                                                                     |
| G3   | Runtime and credential containment | Mend/Core audit dispositions on the chosen release; enforced capture byte budgets, bounded work/requests/streams, credential-to-source binding, restricted Git/mount policy, no administrative reachability from executors. Any residual owner-only risk needs explicit operator acceptance, not silent deferral. |
| G4   | Network and transport              | Pinned generated-proxy resources and selectors, additive-policy review, deployed CNI version/mode, startup-through-convergence allow/deny proof, trusted-forwarding-header tests, private-only Service/Ingress inventory, certificate issuance/renewal and secure cookies.                                        |
| G5   | Owner acceptance and recovery      | Laptop and cellular phone, CLI login, sustained WSS/SSE, reconnect, own-device revocation and rollback pass. Preserve operator access, live sessions and capture flush. No paid tests without approval.                                                                                                           |
| G6   | Teammate rollout                   | Current-main team authorization, operator roles, per-user credentials, live revocation, migration/deletion invariants and two-account capture-mode tests pass. See the sequence below.                                                                                                                            |
| G7   | Public Mend                        | G1-G6 as applicable plus public abuse/spend controls, independent security reassessment, recovery/retention and approved public-edge/domain design. Private-network containment cannot stand in for application authorization.                                                                                    |
| G8   | Public Core                        | Not part of this plan. A separate authenticated-delegation design must fail closed, derive mandatory owner scope, enforce budgets, bind credentials to destinations, and pass independent tests before any exposure proposal.                                                                                     |

Source-inferred from the companion reviews: separate logins in the released Mend build do not
establish project isolation. Core expects a trusted service caller rather than ordinary end-user
access. Tailscale and TLS improve the network boundary; neither changes those application contracts.
A green team repository test or a working home page cannot satisfy these gates.

## What the AWS deployment already has

Observed in the deployment record, not re-probed here:

- EKS 1.35 in Frankfurt, one private ARM64 `m7g.large` node, two subnet AZs, one NAT gateway. The
  public EKS API is operator-IP allowlisted; private API access also exists.
- Mend API/web 0.27.5 and Core API/worker 0.32.0. No public application ingress. The current
  operator reaches `mend-web:3105` through a loopback-only port-forward.
- S3 authoritative captures, Postgres pointers, EBS RWO for Mend's central store/cache and Zot.
  PlanetScale is reached over PrivateLink with verified TLS, separate scoped application roles, and
  a provider-side private-address restriction. No shared filesystem.
- Internal TCP session NLB, `3106 -> NodePort 31006`, admits the MicroVM connector security group
  only. This is an executor channel using session tokens and private-VPC HTTP, not browser ingress
  or end-to-end TLS.
- The fixed MicroVM image is separate from the OCI BuildKit output. Neither the VM nor a build job
  belongs in a tailnet. This plan changes no runtime image, capture path, or Docker setting.

Source-inferred from AWS `deploy/aws/scripts/render-mend.py` and the chart:

- `web.appUrl` is still `http://localhost:3105` in the AWS renderer.
- `api.trustedProxyCidrs` names the private subnet CIDRs. This is forwarding-header trust for
  pairing rate limits, not an authentication or ingress allowlist.
- `networkPolicies.clientCidrs` affects both web 3105 and API 3101. Do not fill it with the tailnet
  range or all pod subnets as a shortcut for ingress. The proxy reaches the backend from a pod, not
  with the laptop's tailnet source address.
- The web policy currently admits the release namespace, not a Tailscale proxy namespace. API and
  web policies also have broad same-namespace ingress and open egress. Enabled VPC CNI policy
  support does not prove that proposed selectors work or that all internal paths are isolated.

### A configuration blocker reproduced locally

Rendering the baseline chart with a synthetic HTTPS `web.appUrl` put `APP_URL` on `mend-api` but not
on `mend-web`. The web template also has no `MEND_ALLOWED_ORIGINS` injection. The AWS branch's web
template has the same omission. Despite the `extraEnv` comment saying both tiers, the web Deployment
does not call the helper that renders those entries.

The web `/trpc` handler loads `@mend/network` independently and checks the browser Origin.
Source-inferred consequence: changing only `web.appUrl` can leave web-side tRPC checking the
localhost default while the API accepts the tailnet origin. This review reproduced the rendered
configuration mismatch, not a deployed browser failure.

Before rollout, ship a reviewed chart correction with a render regression test. Both tiers need the
same public-origin values. Do not copy the entire API environment helper into web: it also supplies
DB and service-principal secrets that web must not receive. No code fix is included in this plan.

## Normal user experience

These are proposed acceptance stories, not claims that the new endpoint is running.

### Laptop

1. Install Tailscale, sign in to the approved tailnet identity, and get the device approved. Keep
   Tailscale connected and use its DNS settings. No kubeconfig or AWS credentials are needed.
2. Bookmark the operator-provided full HTTPS address, for example
   `https://mend-access.<actual-tailnet-name>.ts.net`. The tailnet suffix is not known or claimed
   here. Do not use an IP address or bare `https://mend-access` as the browser origin.
3. Sign in to Mend separately. Tailscale admits the connection; Mend owns the application identity.
   Do not turn Tailscale identity headers into automatic Mend administrator login.
4. Install the compatible Mend CLI and use the same base URL, with no `/api` suffix:

   ```sh
   export MEND_URL='https://mend-access.<actual-tailnet-name>.ts.net'
   mend login --url "$MEND_URL"
   mend doctor
   ```

   `mend login` opens `/authorize` and saves a revocable device credential locally. Never put that
   credential in `MEND_URL`, a shared shell profile, a URL query, or this runbook.

5. Connect your own provider accounts in Settings or through `mend connect codex`,
   `mend connect claude`, and `mend connect github` after authenticating with those providers on
   your laptop. No inference is required to test network access. A stored account marked active does
   not establish that the provider will accept or refresh it.
6. Open projects, review, SSE updates, and terminals through the same HTTPS origin. Interactive
   terminals use WSS through Mend, never direct daemon ports. Closing the laptop should not itself
   stop the supervised process. Recovery behavior must pass the proof checklist.

### Phone

1. Install the Tailscale mobile app, join the same approved tailnet, and enable the VPN connection.
2. Open the same full HTTPS bookmark in the browser and sign in to your own Mend account. Review and
   respond from the browser; no terminal app or tunnel is required.
3. For a client that supports Mend's pairing flow, run `mend pair --url "$MEND_URL"` on your
   signed-in laptop and redeem its single-use code on your own device. CLI help documents a
   ten-minute lifetime. Pairing does not enroll a device into Tailscale or grant network access. Do
   not send your pairing code to a teammate: it delegates your identity, not theirs. Browser
   password login remains the straightforward path if the chosen phone client does not support token
   pairing.
4. Test Wi-Fi-to-cellular switching, screen lock/unlock, VPN reconnect, review, and a WSS terminal.
   A mobile OS can suspend the connection. Reconnect must restore the view without duplicate input;
   uninterrupted foreground sockets are not promised.

### Teammate joining and leaving

Joining is two independent approvals. A tailnet administrator invites the teammate as a member,
approves their devices, and adds their identity to `group:mend-users`. Separately, Mend must give
their own account only the reviewed project/team permissions. They connect their own inference
accounts. Do not share the owner's password, pairing token, connected account, or Core service key.

Blocked: the companion review says the unfinished team implementation is not ready to ship and is
not assumed deployed. Open registration is not an invitation system. Do not admit teammates merely
because separate account creation works. Shared session control delegates access and spend through
the session owner's credentialed process. Agree on that authority before enabling it; per-user
account storage alone does not settle it.

### Team rollout dependencies

Proposed implementation sequence, with invitations disabled until the complete boundary passes:

1. Add a two-account authorization regression harness. Prove authorization precedes mutations,
   indirect-resource reads, filesystem access and platform calls; return uniform inaccessible
   responses. Apply the same policy to terminal upgrades, SSE and authenticated service tunnels.
2. Establish operator-only instance administration, allowlisted or disabled host mounts, reference
   ownership and an explicit policy for project links at creation and every launch. Keep raw service
   listeners disabled. Scope notifications and Git signing bridges to users.
3. Add database scope/role invariants, last-owner recovery and account-deletion semantics that never
   widen project visibility. Test concurrent invite acceptance and removal. Legacy instance projects
   need an approved ownership migration, not first-user claiming.
4. Port the model onto current main in small reviewed changes. Preserve `installCommand`,
   `WorktreeReads`, captured `SessionRepository`, capture stamps, flush, replan and retention.
   Allocate a new migration after existing migrations and a distinct ADR number; do not transplant
   old filesystem-authoritative handlers or the entire old engine.
5. Partition prewarmed workspaces by authorized user and project, or disable warming for scopes
   without proven isolation. Never transfer a credential-bearing workspace between users. Couple
   membership/scope changes to open sockets, service forwards, session/capture grants and new
   presign issuance. Define what happens to removed users' still-running sessions and credentials.
6. Finish join and management UI, access-loss cache invalidation, actor audit and migration
   recovery. Resolve the reviewed web typecheck failure. Run forced repository gates plus two-user
   acceptance in both capture and supported co-located modes before inviting even a pilot teammate.

S3 prefixes and store paths are addresses, not permissions. Re-scoping a project must change who can
resolve capture pointers without moving blobs or bypassing leases. Existing presigned URLs remain
capabilities until expiry; document the bounded residual lifetime and stop replacement URL issuance.
Access removal cannot erase data a user already downloaded.

Approval is still needed for operator roles, collaborator control of owner-credentialed sessions,
cross-scope links, reference ownership, account deletion and revocation of running work. The
conservative interim choice is owner-only access with no new team invitations.

For departure or a lost phone:

1. Remove the affected network grant immediately. For a departing teammate, suspend their Tailscale
   user and remove their devices; for a lost phone, remove that device. Keep device approval on so
   the lost device cannot simply rejoin. Tailscale documents immediate device disconnection and
   suspended users being unable to exchange traffic [T10, T11]. Verify that on the selected clients.
2. Revoke Mend device tokens and browser sessions and remove team/project membership through the
   supported, audited application path. If administrator-driven revocation is missing, keep team
   rollout blocked rather than inventing a UI or doing ad hoc production SQL.
3. Test both a new request and an already-open WSS/SSE connection. Network revocation does not erase
   Mend tokens, and application logout does not remove tailnet access. Active application streams
   must stop when their authorization is revoked; companion reviews must establish how.
4. Review active sessions and injected provider credentials. Removing an account reference need not
   erase a credential already injected into a running executor. Stopping that user's work or
   rotating provider credentials needs an explicit, coordinated decision; do not stop other users'
   executors or discard captures. Record what was revoked and what remains running.

## Proposed traffic and trust boundaries

```text
Approved laptop/phone Tailscale client
  -> tailnet grant: TCP 443 to Mend ingress identity only
  -> standalone Tailscale Ingress / Serve, HTTPS termination
  -> mend-web ClusterIP:3105
       / and /trpc -> web application
       /api/*      -> mend-api ClusterIP:3101, including auth, SSE and WSS
  -> Mend authenticates/authorizes each user
  -> Mend uses the public Sealant SDK with server-side per-user identity

Untrusted MicroVM
  -> existing private session NLB:3106, scoped session protocol only
  -> presigned S3 operations and approved provider/Git traffic
  -X-> administrative tailnet, Core API, DB, registry, Kubernetes API
```

The `-X->` line is a required boundary to verify, not a claim that every current VPC route has
passed a deny probe. No such live probe ran in this documentation phase.

The Tailscale proxy terminates browser TLS. The proxy-to-web and web-to-API hops remain cluster HTTP
under this first proposal. Tailnet encryption does not encrypt those hops or the MicroVM session
NLB. If cluster-internal TLS is required, approve and test it separately rather than claim this
topology already provides it.

Hard exclusions:

- No Tailscale auth material, node state, OAuth credentials, kubeconfig, service-account token, or
  administrative tags in MicroVM images, launch archives, harness homes, BuildKit jobs, or captures.
- No subnet router, exit node, application connector, cluster egress proxy, API-server proxy, or
  route advertisement. Do not route the VPC, pod/service CIDRs, or the administrative tailnet to
  ordinary users. Never enroll coding executors into the administrative tailnet, even temporarily.
- No user access to Core 4000, registry 5000, Postgres 5432, Kubernetes 443/6443, Mend API 3101 as a
  separate endpoint, session channel 3106/31006, SSH gateways, or raw daemon control ports.
- Leave `serviceHost.expose.enabled=false` and default private service bindings unchanged. Raw
  development-service forwards have no Mend request authentication. They are not part of this
  recommendation. Any future preview needs a separate origin and authorization review because
  executor-served HTML is untrusted; never serve it under the authenticated Mend origin.
- Tailscale grants constrain tailnet traffic, not arbitrary VPC traffic [T7]. Preserve destination
  security groups, namespace isolation, least-privilege IAM, and the MicroVM connector boundary.
  Capture contents and provider credentials remain sensitive regardless of transport.

Prefer a dedicated application-access tailnet if the existing administrative tailnet's policy cannot
be narrowed without disrupting others. An existing tailnet is acceptable only after its complete
policy, resource tags, and user roles pass review. This is an approval decision, not permission to
create a new tailnet overnight.

## Operator prerequisites and restrictive policy

Everything in this section is proposed and requires approval before applying.

1. Obtain approval for the tailnet, administrator/backup operator, hostname,
   certificate-transparency disclosure, membership list, billing plan, and maintenance window. Use a
   neutral hostname because publicly trusted certificates disclose the full name in CT even for
   private services [T5].
2. Verify Kubernetes administrative rights using the already authorized AWS operator identity.
   Install CRDs and review chart RBAC; tailnet membership must never grant Kubernetes RBAC. Retain
   the existing operator-IP restriction. A root-console AWS identity is not an EKS access grant.
3. Select an exact stable operator chart version from `https://pkgs.tailscale.com/helmcharts`,
   record chart and ARM64 image digests, and render it offline before rollout. Pin operator and
   proxy to the same tested version. Keep the operator chart render and generated ingress-proxy
   evidence as separate artifacts: the chart does not render the StatefulSet and Pods that the
   controller creates later. Official minimum Kubernetes version is 1.23; that alone is not proof of
   EKS 1.35 acceptance [T3]. No exact release was selected or installed in this review.
4. Enable MagicDNS and HTTPS certificates with the tailnet owner's consent. Clients must accept
   tailnet DNS. Ingress supports HTTPS only and Prefix routing; the first connection may wait for
   certificate issuance [T2, T4]. Use the actual Ingress address as the final hostname.
5. Configure tags before creating devices. The operator tag owns the ingress tag. Create the
   operator OAuth client with the currently documented write scopes `General/Services`,
   `Devices/Core`, and `Keys/Auth Keys`, scoped to the operator tag [T1]. OAuth is proposed for the
   first rollout; workload identity federation is a supported alternative, not implemented here.
6. Supply OAuth material through an approved Kubernetes Secret workflow, never Helm `--set` shell
   arguments, Git, stdout, or a capture. The inspected upstream chart supports a precreated
   `operator-oauth` Secret with `client_id` and `client_secret` keys when `oauth` values are unset.
   Confirm this against the pinned chart [T14]. Treat operator/proxy state Secrets and backups as
   credentials too. Restrict who can read them or create exposure resources.
7. Keep `apiServerProxyConfig.mode: "false"`; do not enable impersonation. Set
   `operatorConfig.defaultTags: ["tag:mend-operator"]` and
   `proxyConfig.defaultTags: "tag:mend-ingress"`. Reserve those tags exclusively for this service.
   No application capability grants or Tailscale SSO mapping are needed.
8. Check operator pod security and resources in the pinned chart render. Separately inspect the
   standalone ingress proxy resources produced for the exact Ingress and ProxyClass, using pinned
   controller fixtures or an approved disposable reconciliation test before rollout. Record their
   provenance and hashes. Verify the ARM64 image digest, dedicated labels and tag, service account,
   security context, resources, and absence of unintended host/network exposure. Use standalone L7,
   not the privileged L3/ProxyGroup examples by accident. Upstream documents privileged defaults for
   several other proxy modes [T8]; do not label the entire application namespace privileged to make
   them work. No `hostNetwork`, host mounts, or worker-node tailnet enrollment is needed by this
   proposal.
9. Preserve outbound connectivity through the existing NAT. DNS and TCP 443 to Tailscale control,
   relays, and certificate services are necessary. UDP to 3478 and peer destinations improves direct
   connectivity; TCP 443 DERP is the fallback. TCP 80 is documented as optional [T9]. Do not open
   public inbound ports to improve latency. Test and budget for relayed connections.

A policy for a new, dedicated access tailnet could look like this. Identities are synthetic and must
be replaced and validated with the tailnet policy editor. It is not a blind replacement for an
existing policy:

```json
{
  "groups": {
    "group:mend-users": ["owner@example.com"]
  },
  "tagOwners": {
    "tag:mend-operator": ["autogroup:admin"],
    "tag:mend-ingress": ["tag:mend-operator"]
  },
  "acls": [],
  "grants": [
    {
      "src": ["group:mend-users"],
      "dst": ["tag:mend-ingress"],
      "ip": ["tcp:443"]
    }
  ],
  "tests": [
    {
      "src": "owner@example.com",
      "accept": ["tag:mend-ingress:443"],
      "deny": [
        "tag:mend-ingress:22",
        "tag:mend-ingress:3101",
        "tag:mend-ingress:3106",
        "tag:mend-ingress:4000",
        "tag:mend-ingress:5000",
        "tag:mend-ingress:5432",
        "tag:mend-operator:443"
      ]
    }
  ]
}
```

An empty legacy ACL list is explicit. Do not leave the starter allow-all rule or broad existing
grants in place: grants/ACLs are additive; a narrow grant cannot subtract an earlier broad allow.
The default newly created tailnet policy allows all devices [T7]. Add policy-editor deny tests for
an actual non-member, administrative targets, and every excluded service. Deny entries in tests are
assertions, not deny rules. No `funnel` node attribute, SSH grant, or route/service auto-approval is
required for standalone L7. Do not enable Funnel through the Serve consent flow [T6].

Ordinary users must not own these tags, write Ingress/Service/ProxyClass/Connector resources, read
operator Secrets, or change policy. That is part of the exposure boundary. Changing a resource tag
later may not retag an existing device; inspect actual device tags rather than trusting annotations
alone [T4].

## Configuration to prepare, not apply yet

### Same origin on every client and server

For the final assigned address:

```text
APP_URL=https://mend-access.<actual-tailnet-name>.ts.net
MEND_ALLOWED_ORIGINS=[]
MEND_URL=https://mend-access.<actual-tailnet-name>.ts.net
```

`APP_URL` and the JSON `MEND_ALLOWED_ORIGINS` value must be present consistently in API and web.
`MEND_URL` is a client setting. It does not change server origins. Do not set `MEND_APP_URL` to the
public URL: that is the web process's internal app upstream. Keep `MEND_API_URL` cluster-internal.

Source-inferred from `packages/network/src/public-network.ts` and `packages/auth/src/auth.ts`:
BetterAuth `baseURL` is `APP_URL`, its base path is `/api/auth`, and `trustedOrigins` comes from
that primary origin plus exact configured alternates. Leave `BETTER_AUTH_TRUSTED_ORIGINS` unset; the
implementation rejects a second ambient allowlist. No wildcard, trailing path, query, fragment, IP
bind address, or forwarded-host discovery grants trust. Keep the persistent signing secret and
production settings; leave `MEND_STATIC_TOKEN` unset.

If retaining the existing loopback operator URL during cutover, add only its exact origin as a
temporary alternate on both tiers. Document when it is removed. Do not weaken cookie security to
support old plain-HTTP sessions. Maintain independent operator access and reauthenticate if the new
HTTPS cookie/base-URL behavior requires it. Test rollback authentication before removing the old
route.

The web proxy removes incoming forwarded host/proto metadata and keeps an appended `X-Forwarded-For`
chain. Preserve the browser Origin and credentials through ingress, and let the configured origin
determine trust. Review `MEND_TRUSTED_PROXIES` for the actual proxy and web pod hops, including
whether Serve resets or appends caller-supplied forwarding headers. A trusted pod CIDR is a
rate-limiter trust decision, not proof that every pod in it is a proxy. Synthetic header spoofing
and throttling tests are required before expanding beyond the owner.

### Ingress shape

This is an illustrative manifest, not an installed resource. It points only at the existing web
Service. Deliberately omit `tailscale.com/proxy-group` for the one-node trial and omit all Funnel
annotations. Choose a collision-free hostname and use the returned full address.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mend-access
  namespace: mend
  annotations:
    tailscale.com/tags: tag:mend-ingress
spec:
  ingressClassName: tailscale
  tls:
    - hosts:
        - mend-access
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: mend-web
                port:
                  number: 3105
```

Operator L7 uses Serve [T2]. There is no separate exposed API hostname and no second terminal
listener. `/trpc`, `/api/auth`, API streams, and WSS traverse this origin; do not route `/api` to
Core or expose Core under a hidden path. TLS is operator-managed for the MagicDNS name, not an
arbitrary `tls.secretName` custom-domain solution. Test real WSS upgrades and sustained traffic; a
page loading successfully is insufficient transport evidence.

### NetworkPolicy and the executor boundary

Prepare a chart-supported policy change or narrowly scoped companion manifest. Select the exact
proxy pods in `tailscale` using labels verified on the generated proxy resources, preferably an
explicit Mend-only pod label through `ProxyClass`. The web allow rule must combine that namespace
selector and that pod selector in the same `from` item, with TCP 3105 only. Two separate items mean
OR and would widen access. Prove that a different proxy in the same namespace cannot use the rule.
Do not use a namespace-only rule for all future Tailscale proxies.

Keep web and API Services ClusterIP. Limit API user-request ingress to web pods on 3101, while
retaining the separately reviewed executor session-channel rule on 3106. Preserve the NLB connector
security-group check, its SNAT implications, and the AWS chart's `sessionChannelCidrs` support. Do
not replace the AWS chart with the main-branch chart, which lacks those deployment additions.

The existing policies admit the whole Mend namespace and have open egress. Adding a restrictive
policy cannot remove those allowances. Replace or narrow the relevant existing rules, with
before/after synthetic tests, before claiming default-deny isolation. Inspect all policies selecting
each pod; Kubernetes combines their allows. Prove CNI enforcement rather than merely reading the
`networkPolicies.enabled` value. Record the deployed VPC CNI and node-agent versions plus
`NETWORK_POLICY_ENFORCING_MODE`. AWS documents an initial default-allow interval in standard mode
[T15], so test denied connections from initial pod execution through policy convergence and restart,
not only after steady state. Choosing strict mode is a separate approved change and requires
explicit DNS and dependency rules. Preserve DNS, health probes, operator Kubernetes API/Secret
access, S3, DB, Core and external provider/Git dependencies according to each component's role.
Proxy pods must not acquire broad access to DB, Core, registry, or the MicroVM session channel.

Blocked: exact generated proxy resources and labels, policy render, resource sizing, VPC-CNI mode,
and startup enforcement for this route have not been tested. None of the proposed network changes
should be applied before that review.

## Rollout and proof checklist

The operator, not normal users, performs this once during an approved window. Do not run paid
inference or launch a MicroVM merely to prove ingress. Use synthetic fixtures first; any live
terminal test must use an explicitly authorized session with agreed cost and cleanup.

1. Record G1-G5 audit dispositions and the chosen release/commit for Mend and Core. Close required
   blockers with focused regression tests and approved release deployment before this access-only
   cutover. Keep access owner-only until G6 passes. Team migrations and runtime upgrades must not be
   hidden inside the ingress change.
2. Inventory current non-secret workload versions, Service types, ingress resources, security
   groups, VPC CNI/node-agent versions and enforcement mode, and Helm revision. Preserve existing
   configuration, DB, captures, claims, and operator access. Backups containing credentials stay
   private. Use an explicit AWS account, region, kubeconfig and Kubernetes context from the private
   handoff, never ambient defaults.
3. Review the complete tailnet policy, validate accept/deny assertions, then approve enrollment and
   apply restrictive grants before exposing anything. Provision OAuth credentials out of band.
4. Install the pinned operator and verify only the intended operator identity joined. Apply the
   reviewed backend policy and public-origin configuration. Keep the current operator tunnel until
   acceptance; do not stop a user's sessions to test a network change.
5. Create the single Ingress. Compare the generated proxy resources with the separately reviewed
   fixture/reconciliation artifact before accepting their selectors or security properties. Confirm
   no public AWS LoadBalancer was created, no Funnel enabled, no subnet routes advertised, no API
   proxy enabled, and no accidental Services exposed. Verify the actual proxy labels, service
   account, security context, resources, image digest, device tags and certificate hostname.
6. Warm the first HTTPS request, verify the certificate chain/SAN, and confirm its renewal path.
   Official docs describe first-request issuance, active-traffic renewal and rate limits [T2-T5].
   Monitor certificate expiry and probe through an approved tailnet client; avoid repeated resource
   deletion that burns issuance limits. Do not mistake Let's Encrypt staging certificates for
   browser-trusted production certificates.
7. Complete and record the following matrix. Save timestamps, versions and redacted outcomes, not
   tokens, full response bodies, presigned URLs, terminal contents, or raw headers.

| Proposed proof                                   | Required result                                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approved laptop, Tailscale on                    | Full HTTPS origin loads; certificate trusted; Mend login and logout work.                                                                                                                        |
| Phone on cellular, Tailscale on                  | Same origin loads and supports review, response and a terminal; no local tunnel.                                                                                                                 |
| Tailnet off or unapproved device                 | Cannot reach Mend through this endpoint; no alternate public route.                                                                                                                              |
| Tailnet member outside Mend group                | Network access denied, including attempted alternate ports.                                                                                                                                      |
| Approved network client without Mend credentials | No protected API data, tRPC data, SSE stream, or terminal upgrade.                                                                                                                               |
| Exact allowed and malicious Origins              | Allowed requests work; unlisted cookie writes/upgrades fail; forwarded headers cannot add origins.                                                                                               |
| HTTPS cookie/auth flow                           | Secure cookie behavior, correct redirect/authorization URLs, no localhost leak, no mixed content.                                                                                                |
| CLI and pairing                                  | HTTPS MEND_URL, browser authorization, one-use expiry, wrong-code throttling, replay rejection and token revocation work.                                                                        |
| WSS terminal and SSE                             | Upgrade reaches Mend, input/resize are authorized, events stream without buffering, sustained idle/active connection survives an agreed test interval.                                           |
| Proxy/web restart and phone network switch       | Client reconnects without duplicate commands or silent stream gaps; record continuity checked.                                                                                                   |
| Proxy startup and policy convergence             | Protected destinations stay denied from initial process execution through restart and steady state; another proxy in the namespace cannot inherit Mend access.                                   |
| User A versus user B, G6 before teammates        | Project/session visibility, reads, mutations, streams, terminals and account references obey the reviewed sharing model. Session-owner delegation is explicit; no implicit credential borrowing. |
| Member removal / lost device                     | New requests denied and existing WSS/SSE access ends; reauthentication/re-enrollment cannot bypass removal.                                                                                      |
| Internal services from ordinary client           | Core, registry, DB, Kube API, session channel and raw daemons unavailable.                                                                                                                       |
| Synthetic executor boundary                      | No administrative tailnet material; connector cannot reach control APIs/DB/registry; only approved session and presigned-object paths work.                                                      |
| Reverted configuration                           | Original operator access still works with compatible origins and no new exposure.                                                                                                                |

A real executor boundary probe, restart, or user revocation can disrupt work. Run synthetic tests
first and require separate approval for those live checks. Do not probe another user's credentials
or mutate their resources. Companion reports must define the safe test identities and environments.

### Operator command templates

Proposed commands, not executed here. These are deliberately incomplete until an operator fills
approved inputs from the private handoff. `KUBECONFIG` names that deployment's private kubeconfig;
`KUBE_CONTEXT` is its explicit context. Never infer either from the current shell. `REVIEW_DIR` is a
mode-0700 directory containing reviewed, non-secret files. Do not export raw credentials or print
Secrets, Helm release values, environment dumps or verbose authenticated HTTP traces.

Prepare `operator-values.yaml` there with the exact image digests, resource limits and tags from the
prerequisites. Leave `oauth` unset, preserve the default release fullname, and provision
`operator-oauth` separately through the approved Secret workflow. The two proposed policy/Ingress
files below are not supplied deployable artifacts; they require G2-G4 review first.

Local chart preparation only:

```sh
: "${OPERATOR_VERSION:?Set the approved exact stable chart version}"
: "${REVIEW_DIR:?Set the private review directory}"
umask 077
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm repo update tailscale
helm pull tailscale/tailscale-operator --version "$OPERATOR_VERSION" \
  --destination "$REVIEW_DIR"
OPERATOR_CHART="$REVIEW_DIR/tailscale-operator-$OPERATOR_VERSION.tgz"
helm template tailscale-operator "$OPERATOR_CHART" --namespace tailscale \
  -f "$REVIEW_DIR/operator-values.yaml" > "$REVIEW_DIR/operator-render.yaml"
```

Inspect the render and archive its checksum. It must contain no OAuth values, unwanted API proxy,
routes or public-service configuration. This render covers the operator installation only; it does
not contain the ingress proxy resources the controller later creates. Review those separately using
the pinned fixture or approved disposable reconciliation artifact described above. Render the
corrected AWS Mend chart separately with synthetic values first. Never substitute the baseline
chart, which still omits web origin values.

Only after G1-G4 approval and approved application release/configuration work, the operator may use:

```sh
: "${KUBECONFIG:?Use the authorized private kubeconfig}"
: "${KUBE_CONTEXT:?Use the explicit context from the private handoff}"
: "${OPERATOR_CHART:?Use the reviewed local chart archive}"
: "${REVIEW_DIR:?Use the reviewed private directory}"
helm upgrade --install tailscale-operator "$OPERATOR_CHART" \
  --kubeconfig "$KUBECONFIG" --kube-context "$KUBE_CONTEXT" \
  --namespace tailscale --create-namespace \
  -f "$REVIEW_DIR/operator-values.yaml" --wait --timeout 5m
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" \
  apply -f "$REVIEW_DIR/mend-access-networkpolicy.yaml"
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" \
  apply -f "$REVIEW_DIR/mend-access-ingress.yaml"
kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" \
  -n mend get ingress mend-access -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

The apply sequence assumes approved origins and replacement of broad existing policy rules are
already complete. Adding another policy alone does not narrow them. Check the returned hostname
against `APP_URL` before distributing it. A Helm wait timeout is a failed acceptance step, not
permission to widen policies. Certificate and phone/WSS acceptance still follow; these commands
alone do not establish G5.

## Rollback

Rollback is an approved operational action, not something this documentation phase performed.

1. If exposure behaves unexpectedly, remove the Mend network grant first and disable/delete only the
   new Ingress. Check both new requests and open streams. For suspected proxy compromise, remove
   that tailnet device too. Do not wait for DNS expiry as an access-control measure. After
   withdrawing the grant in the policy editor, the specific Ingress removal command is:

   ```sh
   : "${KUBECONFIG:?Use the authorized private kubeconfig}"
   : "${KUBE_CONTEXT:?Use the explicit context from the private handoff}"
   kubectl --kubeconfig "$KUBECONFIG" --context "$KUBE_CONTEXT" \
     -n mend delete ingress mend-access --ignore-not-found --wait=false
   ```

   Deletion is asynchronous. Verify proxy withdrawal and held connections separately; remove the
   proxy device in the Tailscale console if isolation is uncertain. Do not use a bulk namespace or
   CRD delete.

2. Preserve proxy state for diagnosis if it is not compromised, with credential handling. Revoke
   OAuth credentials when abandoning the installation; revoking OAuth alone is not proof that
   already-enrolled proxy devices lost access. Inventory and remove orphaned devices explicitly.
3. Restore the previous origin and policy configuration from the recorded revision. Use only the
   same or a schema-compatible application version. This access change should not include a DB
   migration; never combine its rollback with unreviewed database restore or application downgrade.
4. Verify the existing private operator route, API/web health and executor capture path. Leave the
   session NLB, store/cache claims, Zot, S3 captures, databases and running executors intact. Do not
   run the AWS teardown procedure or delete namespaces/CRDs as a shortcut.
5. Remove the new namespace/Secret/operator only after checking no other resource depends on it. Do
   not disable tailnet-wide MagicDNS/HTTPS or alter unrelated grants during rollback. Issued
   certificates and CT entries do not disappear when access is removed [T5].

## Docker on Talos versus AWS

Observed in Core 0.32.0 source and the supplied deployment record, not newly tested on either
cluster: AWS workspaces do not currently have Docker parity. This is a runtime implementation and
image contract limitation, not an AWS-wide prohibition on Docker.

| Setting or mechanism                 | Meaning                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_RUNTIME_ADAPTER=microvm`    | AWS launches Firecracker MicroVMs.                                                                                                                                                          |
| `DOCKER_RUNTIME_ENABLED=false`       | Disables the platform's host-Docker workspace adapter. It does not independently control Docker inside a MicroVM.                                                                           |
| Mend profile `services.docker=false` | Does not request a Docker service inside the workspace. Core represents the request as `tooling.services.docker.enabled`.                                                                   |
| `SEALANT_K8S_DOCKER_ENABLED=false`   | Disables the optional Kubernetes workspace Docker service; changing it cannot add a MicroVM service.                                                                                        |
| Talos/Kubernetes Docker service      | A rootless DinD native sidecar, Pod-local Unix socket on shared `emptyDir`, `DOCKER_HOST=unix:///run/docker/docker.sock`, ephemeral graph storage and Pod lifecycle. No node Docker socket. |
| AWS MicroVM Docker service           | Currently refused by the adapter when requested. The fixed guest image has no configured Docker daemon/service. A profile toggle is not a supported fix.                                    |
| Workspace image                      | Kubernetes launches the built OCI image. AWS launches a separately built fixed Amazon Linux MicroVM image, not the workspace BuildKit/Zot artifact.                                         |

The Kubernetes sidecar is privileged inside a user-namespaced Pod with `hostUsers: false`; the
workspace container is not privileged. This depends on correct kernel/runtime user-namespace and Pod
Security configuration. It is not an unprivileged-container claim. Source at the reviewed Core
commit defaults Kubernetes DinD to `docker:28.5.2-dind-rootless`; the separate host-Docker adapter
uses `27.5.1`. These defaults do not prove the image currently running on Talos.

The AWS `node:24-bookworm`, no-extra-packages profile passed OCI build provisioning according to the
brief. That does not mean AWS executed Debian or honored arbitrary package/image customization. The
recorded capture/flush/replacement success used a private candidate with an added `sealantctl` built
from the same pinned daemon source. It does not establish unmodified public-image support or native
Codex/Claude conversation resume. Harness credential files remain live after capture exclusion and
are reinjected on a new launch; exclusion is not runtime credential isolation.

Proposed next runtime work is guest-local Docker behind a Unix socket, preferably rootless, with
readiness, disk/memory/PID bounds and VM-lifetime cleanup. Never mount a host socket or publish a
Docker TCP listener. No FSx or separate EC2 fleet is inherently needed, but guest kernel/cgroups,
nested networking, capture exclusions and cleanup need provider-backed acceptance. Keep the support
refusal until the image, agent and adapter ship and pass together.

Full customization parity is separate. Choose whether to run the digest-pinned workspace OCI image
inside the VM, build a plan-specific VM image, or explicitly reject unsupported customization.
Adding a Docker daemon alone does not make the OCI build output the execution environment.

Blocked: provider launch/spend approval and real nested-Docker tests. The reviewed pinned
Core/daemon Git-source selector compatibility and early-exit reporting also need contract tests and
release correction before claiming Git-source readiness. Capture-source success does not prove the
Git-source path. None of this is required merely to view Mend through the proposed private ingress;
do not combine a Docker rollout with the access cutover.

## One-node availability and cost

This remains a one-node POC. One operator plus one standalone ingress proxy adds pod scheduling,
memory and CPU demand to the existing node. Measure under a build and concurrent terminal streams
before selecting requests/limits. Do not scale the cluster or buy a larger node without approval. An
operator outage can affect reconciliation and enrollment; proxy or node loss affects access. EBS
reattachment is AZ-bound, Mend API supervision remains singleton, and one NAT is another
availability dependency. Two proxy replicas on one node do not provide node-level HA.

Tailscale recommends ProxyGroup HA for production [T2]. A later multi-node design needs distinct
proxy-device and service tags, `autoApprovers.services`, and grants to the service identity rather
than a broad shared tag [T8]. It also needs a Mend API recovery design and storage plan. Do not
paste HA instructions into this standalone plan and assume its grants still mean the same thing.

No new public ALB/NLB or EC2 machine is required by the tailnet-only proposal. Existing EKS, node,
NAT, PrivateLink, internal session NLB, EBS, S3 and PlanetScale charges continue. NAT processing and
Internet transfer for tailnet traffic can add cost, especially for DERP relay traffic; relay latency
and throughput need measurement. The AWS $100 budget is an alert, not a cap, and excludes
PlanetScale. Closing access or deleting an Ingress does not stop infrastructure billing.

The official pricing page fetched on 2026-09-16 lists Personal at $0 for up to six users for
non-commercial use, Standard at $8/user/month, and Premium at $18/user/month. It lists 50 included
tagged resources and additional resource/ephemeral usage terms [T13]. These are published prices,
not this account's entitlement or a quote. Confirm the actual plan, commercial eligibility,
approvals, resource classification and seats before enrollment. Do not assume a commercial team fits
a free personal plan or that removing a user automatically reduces purchased seats.

## Separate options: custom names and public Internet

### Private endpoint with a custom domain

A custom name does not require public application ingress. It does require actual domain control,
which this plan neither establishes nor assumes.

Operator L7 Ingress and Serve use the tailnet's `*.ts.net` names [T4-T6]. A CNAME such as
`mend.example.com -> mend-access.<tailnet>.ts.net` alone does not make Serve present a certificate
for `mend.example.com`. Browser SNI and certificate validation still use the custom name. MagicDNS
is not a general-purpose authoritative DNS editor for arbitrary owned domains.

Tailscale documents a different architecture [T12]: L3 tailnet exposure of a Gateway API proxy, TLS
termination at that gateway with your certificate, and custom/split DNS using a reachable resolver.
Envoy Gateway, cert-manager and ExternalDNS are example components, not prerequisites for the
simpler `.ts.net` plan. This adds controllers, credentials, privileged-proxy considerations, DNS
dependencies and resource use on the one node. Defer it unless the custom name is worth that cost.
Do not advertise the VPC merely to make a resolver reachable; review an explicit DNS-only path if
one is needed.

For a public CA certificate on a private custom endpoint, DNS-01 can validate without public HTTP
access [L1]. The CA must see `_acme-challenge` TXT proof in publicly authoritative DNS. A TXT record
in a private hosted zone, MagicDNS, or a LAN resolver alone cannot satisfy public CA validation.
Split DNS may keep the service address private while the challenge is public. A CNAME/NS delegation
of the challenge can isolate permissions, but the ACME client must support that delegation. Check
authoritative propagation, CAA, provider API support and automated renewal. Grant narrowly scoped
DNS credentials only to the issuer, never to coding executors. Public certificates still disclose
names in CT. DNS-01 proves domain control, not user authorization, and does not make the service
publicly reachable. HTTP-01 requires public port 80 and is not the private-only solution. Do not
open that port to work around a missing DNS permission.

### Public-domain endpoint

No-go now. If later approved, use a separately reviewed Internet-facing HTTPS edge, for example an
AWS ALB with an ACM certificate for an operator-controlled domain, routing only to Mend web. All
application paths, API traffic and WSS still use the same origin. Keep the internal services and
executor channel private. Public DNS, certificate validation, load-balancer controller/IAM, security
groups, rate limits, abuse controls, monitoring, costs and WebSocket idle timeouts all need an
explicit reviewed deployment change. Retain independent private operator access.

Required before even a public pilot:

- G7 closed through remediation and independent reassessment against exact deployed versions. Fix
  authorization, credential-boundary and cost-control blockers; do not carry owner-only risk
  acceptances into an untrusted/public deployment.
- Deliberate signup/invitation policy, administrative bootstrap, account recovery, session/device
  revocation, authorization on every resource and stream, and tested cross-user isolation. Tailnet
  removal would no longer be a fallback perimeter.
- Public abuse limits on authentication, pairing, uploads, work creation, stored/streamed data and
  long-lived sockets, with redacted logs and incident ownership. Public reachability must not let an
  unknown registrant run billable work or reach another user's data or credentials.
- Hardened proxy/header/cookie/Origin behavior; public-origin config applied to both tiers; TLS
  renewal and WSS/SSE acceptance. An identity-aware outer proxy can be an extra gate but must
  support CLI bearer/pairing/streaming flows and does not replace Mend authorization.
- Defined collaboration authority over owner-credentialed executors, recovery/backup tests, spending
  controls and an approved domain owner. Unfinished team code is not evidence of these.

### Core public exposure is a separate no-go

Core 0.32.0 remains private regardless of a future Mend public-domain decision. Service-principal
credentials belong only in authorized server workloads, never in a browser, phone, tailnet client or
public proxy configuration. Keep service authentication configured and verify fail-closed production
behavior, mandatory principal-derived owner scope, credential/destination binding,
request/work/spend limits, retention and revocation. A static service credential plus TLS is not an
end-user authorization design. Any direct Core exposure would require G8 and a separate proposal; no
such exposure is needed for the laptop, phone or teammate stories here.

Funnel is not a private custom-domain workaround. It is explicitly public, does not carry Serve's
tailnet identity headers, and is outside this recommendation [T6]. Do not grant `funnel` or add
`tailscale.com/funnel: "true"`. Buying a domain, obtaining DNS-01 proof, or restricting CORS cannot
repair missing application authorization.

## Source map and official references

Repository evidence:

- `DEVELOPMENT.md`, `docs/SELF-HOSTING.md`, `docs/KUBERNETES.md`: public-origin contract, private
  deployment warning, chart and service-forward behavior.
- `packages/network/src/public-network.ts`, `packages/auth/src/auth.ts`: origins, BetterAuth, open
  signup and device authentication.
- `apps/api/src/public-network-policy.ts`, `apps/web/src/entry/main.ts`,
  `apps/web/src/entry/proxy-headers.ts`, `apps/web/src/routes/trpc.$.ts`,
  `apps/web/src/server/trpc-handler.ts`: same-origin HTTP, tRPC, proxy and upgrade handling.
- `apps/cli/src/help.ts`, `apps/cli/src/main.ts`: MEND_URL, login, pairing and account connection.
- `docs/SEALANT-IDENTITY.md`: per-user identity intent. Historical implementation details in this
  document do not replace the current Core or team audit.
- `docs/adr/0002-session-capture-store.md`: capture-store model. Historical credential-capture
  statements conflict with the supplied pinned-runtime record; do not treat them as proof that
  excluded provider credential files are restored from captures.
- Core `abe4d6c7258a5d6b479b72162de368c45953d9ee`,
  `packages/workspaces/src/runtime/kubernetes/{config,manifests}.ts`, `runtime/microvm/adapter.ts`,
  `runtime/docker-runtime-adapter.ts` and `packages/workspaces/microvm-image/`: source for the
  Docker distinctions above.
- `deploy/helm/mend/templates/{web,api,networkpolicies}.yaml`, `_helpers.tpl`, `values.yaml`:
  rendered topology and origin/configuration gap.
- AWS branch `deploy/aws/README.md`, `kubernetes/README.md`, `scripts/render-mend.py`,
  `tofu/network.tf`, and its Helm network-policy/web templates: deployment record and private
  connector boundaries. The AWS branch was read only.

Official references, fetched 2026-09-16:

- [T1: Operator installation, prerequisites and OAuth scopes](https://tailscale.com/docs/kubernetes-operator/install-operator)
- [T2: Ingress architecture, standalone/HA and certificate limits](https://tailscale.com/docs/kubernetes-operator/ingress)
- [T3: Compatibility and certificate renewal](https://tailscale.com/docs/kubernetes-operator/reference/compatibility)
- [T4: Ingress limitations](https://tailscale.com/docs/kubernetes-operator/reference/limitations)
  and [tag customization](https://tailscale.com/docs/kubernetes-operator/reference/tags)
- [T5: HTTPS setup, DNS-01 and CT disclosure](https://tailscale.com/docs/how-to/set-up-https-certificates)
  and [MagicDNS](https://tailscale.com/docs/features/magicdns)
- [T6: Serve, identity headers, Funnel distinction and naming limits](https://tailscale.com/docs/features/tailscale-serve)
- [T7: Grants](https://tailscale.com/docs/features/access-control/grants),
  [default ACL behavior](https://tailscale.com/docs/features/access-control/acls), and
  [policy syntax](https://tailscale.com/docs/reference/syntax/policy-file)
- [T8: Operator permissions, HA service grants and pod security](https://tailscale.com/docs/kubernetes-operator/reference/rbac)
- [T9: Firewall and DERP connectivity requirements](https://tailscale.com/docs/reference/faq/firewall-ports)
- [T10: Device removal](https://tailscale.com/docs/features/access-control/device-management/how-to/remove)
- [T11: User suspension and deletion](https://tailscale.com/docs/features/sharing/how-to/remove-team-members)
- [T12: Private custom domains with Gateway API](https://tailscale.com/docs/solutions/kubernetes-operator-byod-gateway-api)
- [T13: Pricing and eligibility](https://tailscale.com/pricing)
- [T14: Upstream chart values](https://github.com/tailscale/tailscale/blob/main/cmd/k8s-operator/deploy/chart/values.yaml)
  and
  [Deployment](https://github.com/tailscale/tailscale/blob/main/cmd/k8s-operator/deploy/chart/templates/deployment.yaml).
  These are moving upstream source references, not a selected release pin.
- [T15: AWS VPC CNI network-policy startup enforcement](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html)
- [L1: Let's Encrypt challenge behavior and DNS credential guidance](https://letsencrypt.org/docs/challenge-types/)

## Validation and unresolved approvals

Reproduced locally: a synthetic baseline Helm render accepts the requested HTTPS API origin but
omits web origin configuration; web stays ClusterIP, there is no Ingress or default service-range
exposure, and the existing web policy has no Tailscale namespace allow. These checks establish
rendered source behavior only, not cluster enforcement or end-to-end access.

Reproduced documentation checks: 23 local assertions passed, including policy JSON, illustrative
Ingress intent, all shell snippets parsed with `bash -n`, and separation of public/private gates.
All 22 published HTTPS links returned HTTP 200. Command syntax was checked against Mend source and
local Helm/kubectl help; official documentation supplied the policy/TLS requirements. The separate
independent checker passed 21/21 assertions. Marksman and scoped project diagnostics reported no
findings. These checks do not validate an approved pinned operator configuration, evaluate a tailnet
policy or exercise a Kubernetes network boundary.

Observed publication gates on this feature branch: frozen install, root build, direct web,
marketing, and desktop builds, `pnpm format:fix`, the full `pnpm test` task, forced Turbo typecheck,
and forced Turbo lint all exited zero. The first forced typecheck exposed missing ignored route
trees after the cache-hit root build; direct application builds generated them, and the repeated
forced typecheck ran all 22 tasks successfully with zero cache hits. The full test task ran 20
package tasks successfully, with four cache hits. Local build/test success is not deployed evidence.

No live endpoint, policy-editor validation, operator render/install, phone test, WSS endurance test,
provider inference, or executor launch was performed. No runtime code changed.

Changed files in the assigned worktree: only this document. The substantive private access report
records companion finding IDs, source corrections and validation results; exploit details are not
part of the publishable plan. No `*-fixes.md` handoff was available at final review, so audit
recommendations are not counted as implemented fixes.

Blocked approvals are G1-G5 for owner-only rollout, G6 for teammates, G7 for public Mend and a
separate G8 for public Core. Current-private is the recommendation now. Owner-only `.ts.net` is the
smallest proposed next access method after those gates, not a claim of production safety.
