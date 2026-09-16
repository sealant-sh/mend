# AWS owner-only access — observed 2026-09-16

Private HTTPS access is installed at **<https://mend-access.tailc79e49.ts.net>**. Connect Tailscale,
then use the existing Mend login. This is an owner-only pilot, not public or teammate access, and
not a claim that every gate in the [access plan](aws-access-plan.md) has passed.

A later application upgrade deployed Mend **0.28.0** and Sealant **0.33.0** with the separate Docker
workspace image. It preserved this access boundary, origin settings and Tailscale release. See the
[Docker deployment record](aws-docker-service.md) for that operation and its acceptance
qualification; the ingress-installation versions below are historical.

## Installed boundary

- The owner saved a policy allowing only the approved owner identity to reach `tag:mend-ingress` on
  TCP 443. The previous allow-all grant was replaced; unrelated member-to-member access was
  retained. The owner also enabled HTTPS certificates and accepted hostname publication in
  certificate transparency logs. Funnel is not enabled.
- Standalone Tailscale Ingress `mend/mend-access` forwards only to `mend-web:3105`. No subnet
  routes, exit node, Kubernetes API proxy, executor enrollment, or separate Core/admin endpoint was
  added.
- Helm release `tailscale-operator`, namespace `tailscale`, revision 1 uses chart **1.102.3**, with
  the upstream `proxies` Role deliberately changed to `rules: []` before installation. Do not
  upgrade directly from the unmodified upstream chart: that would restore namespace-wide proxy
  access to Secrets, including the operator OAuth credential.
- A separate `mend-ingress-state` Role grants `get`, `patch`, and `update` only on the generated
  proxy's state Secret, plus event creation/patching. The proxy cannot read `operator-oauth`.
  Recreating the Ingress can change the state Secret name; update this exact-name grant rather than
  granting access to every Secret.
- Operator and proxy run as UID/GID 1000 with `RuntimeDefault` seccomp, dropped capabilities, and
  privilege escalation disabled. The namespace enforces Kubernetes restricted Pod Security. The
  generated ingress proxy uses userspace networking, without host networking or host mounts.
- New policies select the Tailscale namespace and explicitly labeled ingress proxy. They allow DNS,
  Kubernetes HTTPS for controller/state operations, public HTTPS/UDP for Tailscale transport, and
  the proxy's connection to Mend web. Private database, Core, registry, direct Mend API and
  instance-metadata connections are denied. These policies do not harden Mend's existing egress.
- At ingress installation, Mend Helm revision **3** kept API/web images at **0.27.5**. Both tiers
  received `APP_URL=https://mend-access.tailc79e49.ts.net` and the alternate origin
  `http://localhost:3105`. That operation left image versions, Secret references, storage and
  session-channel configuration unchanged. Core remained **0.32.0**. No executor was launched for
  ingress verification.

Pinned images, both verified to include ARM64:

| Image                                     | Manifest-list digest                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/tailscale/k8s-operator:v1.102.3` | `sha256:d86a8be7ad9d38714968f5d4e010ba8dad30c8f672736ef94eda9b250febeb12` |
| `ghcr.io/tailscale/tailscale:v1.102.3`    | `sha256:8c42c4574ab066384fcb72f69e086a2ff1dd3652eb6f56856cee34bcf0d2f680` |

## How DNS and HTTPS work

The operator registers the ingress proxy as a Tailscale device named `mend-access`. MagicDNS
resolves `mend-access.tailc79e49.ts.net` to that device's tailnet address for connected clients.
This is not a public load balancer or a public application DNS record.

Enabling **HTTPS Certificates** in the Tailscale console permits certificate provisioning for the
approved `ts.net` names. The L7 ingress proxy uses Tailscale Serve, which obtains a publicly trusted
certificate from **Let's Encrypt**. Tailscale completes the ACME **DNS-01** challenge by publishing
the required DNS TXT record under its `ts.net` domain. The CA verifies DNS ownership; it does not
need to connect to Mend. No public inbound port, AWS ACM certificate, cert-manager installation or
manual certificate upload was needed.

The request path is:

```text
Browser on a Tailscale-connected device
  -> HTTPS over the encrypted Tailscale connection
  -> Tailscale ingress proxy in EKS, where TLS terminates
  -> HTTP to mend-web:3105 inside the cluster
  -> Mend web's existing internal API proxy
```

HTTPS gives the browser a trusted origin and allows Secure cookies. Tailscale separately encrypts
traffic between devices and applies the owner-only access policy. The proxy-to-web hop is HTTP, not
end-to-end application TLS; its access is restricted by the Kubernetes network policies. A public
certificate does not make the service publicly reachable. Its hostname is public in
certificate-transparency logs; Funnel remains disabled.

Serve manages certificate issuance and renewal through the local Tailscale daemon. Certificate
private keys are generated locally, not provided by Tailscale's control plane. This differs from
exporting certificate files with `tailscale cert`, where the operator must arrange renewal and
installation. Preserve the proxy's state and its required outbound connectivity rather than
recreating its identity to renew certificates.

A live TLS inspection on 2026-09-16 confirmed the certificate name, issuer **Let's Encrypt / YE1**,
and expiry **2026-12-15 08:30:50 UTC**, using normal certificate verification. Initial issuance is
verified; automatic renewal has not yet been exercised.

References: [Tailscale HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) and
[Kubernetes ingress](https://tailscale.com/kb/1439/kubernetes-operator-cluster-ingress).

## Observed checks and remaining acceptance

Passed from the owner's laptop:

- HTTPS home and API health: 200, with certificate verification enabled.
- Unauthenticated projects request: 401; authenticated request: 200.
- Existing diagnostic account sign-in: 200 with a Secure, HttpOnly cookie. Only the new diagnostic
  login session was signed out afterward. A sign-in request from an unapproved browser origin
  received 403.
- Tailnet proxy TCP 443 reachable; 22, 3101, 3106, 4000 and 5432 unreachable.
- From the proxy pod: Mend web and Kubernetes HTTPS reachable; direct Mend API, Core, registry, the
  tested PrivateLink database address and EC2 instance metadata unreachable.
- Kubernetes authorization checks: proxy state Secret readable; operator OAuth Secret denied.
- Authenticated SSE: 200 with `text/event-stream`, and the 25-second heartbeat received through the
  HTTPS proxy. This is a heartbeat check, not a sustained reconnect test.

Remaining: cellular phone acceptance, interactive CLI login, sustained terminal WSS, reconnect,
certificate renewal, device revocation and a rollback exercise. No paid session was started to
complete these tests. A real non-owner device denial has not been exercised; the owner-confirmed
policy and its tests are not a substitute for that check.

The CNI remains **v1.23.1-eksbuild.1**, network-policy agent **v1.4.2-eksbuild.1**, in **standard**
enforcement mode. The network tests above establish steady-state behavior, not startup-through-
convergence isolation. Standard mode can briefly allow traffic before policy attachment. Changing
CNI mode is a separate cluster-wide change, not part of this access installation.

Open enrollment and the previously reported application authorization, credential, resource-budget
and stream issues are not fixed by this rollout. G2–G5 therefore remain incomplete. Keep access
owner-only; do not invite teammates or expose the app publicly on the strength of these checks.

## Private operational files and upgrades

The approved policy, OAuth credentials, original and modified chart, image pins, before/after Mend
values, namespace/ProxyClass/Ingress/policy/RBAC manifests and verification results are under
`~/.config/mend/aws-poc/tailscale/`, outside Git. Preserve this directory with the existing private
POC configuration. Treat credentials, Helm backups and generated proxy state as sensitive; do not
print or commit them.

The chart archive preserves the upstream package; the extracted chart contains the reviewed RBAC
change. Installation used that extracted chart because the installed Helm 4 expects a plugin name,
not an executable path, for `--post-renderer`. The saved Python renderer alone is **not** a Helm 4
plugin. Reapply and review the RBAC change when preparing a future chart version.

The Kubernetes API egress allowlist includes its Service IP as well as the observed endpoint IPs;
endpoint-IP-only rules timed out on this CNI. Recheck the rules after control-plane/network changes.
Do not replace the saved HTTPS-aware Mend values with the original localhost-only renderer output on
a subsequent deployment.

## Fallback and removal

A port-forward terminates when its selected web pod is replaced. Re-establish it after rollouts:

```sh
nix-shell deploy/aws/shell.nix
export KUBECONFIG="$HOME/.config/mend/aws-poc/kubeconfig"
kubectl --context mend-aws-capture-poc -n mend port-forward \
  --address 127.0.0.1 svc/mend-web 3105:3105
```

This preserves transport to the app. Do not assume HTTPS cookie sessions work over HTTP; use the
existing CLI bearer login for fallback administration, or restore the previous origin configuration
under an approved rollback.

Removal requires approval. Keep the operator running while deleting `mend/mend-access` so its
finalizer can remove the proxy and tailnet device. Verify that cleanup before uninstalling
`tailscale-operator` and removing its dedicated namespace, ProxyClass, remaining Mend ingress
policy, operator device, OAuth client and unused policy tags/grants. Do not remove unrelated tailnet
access or cluster resources. Removing the access path does not stop executors or tear down
AWS/PlanetScale.
