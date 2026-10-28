{{- define "mend.tag" -}}{{ .Values.image.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "mend.image" -}}{{ .Values.image.repository }}:{{ include "mend.tag" . }}{{- end -}}
{{- /* Per-tier image: api/web default to their slim images, fall back to the shared image block. */ -}}
{{- define "mend.tierImage" -}}
{{- $tier := index .root.Values .tier -}}
{{- $repo := default .root.Values.image.repository (dig "image" "repository" "" $tier) -}}
{{- $tag := default (include "mend.tag" .root) (dig "image" "tag" "" $tier) -}}
{{ $repo }}:{{ $tag }}
{{- end -}}
{{- define "mend.labels" -}}
app.kubernetes.io/name: mend
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
{{- define "mend.component" -}}
app.kubernetes.io/name: mend
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .name }}
{{- end -}}
{{- /* The API Pod's RWO store claim: an operator-made claim wins, else the chart's own. */ -}}
{{- define "mend.storeClaim" -}}
{{- if .Values.store.existingClaim -}}{{ .Values.store.existingClaim }}
{{- else if .Values.store.create.enabled -}}{{ .Release.Name }}-store
{{- else -}}{{ fail "store: choose explicitly — store.existingClaim=<claim> (an upgrade from chart 0.1.x: mend-store, so legacy worktrees on it are backfilled at first launch) or store.create.enabled=true (a fresh install)" }}
{{- end -}}
{{- end -}}
{{- /*
The capture store's bucket (captureStore.blobStore): exactly one of an ObjectBucketClaim's
outputs or a plain URL. Returns "obc" or "url".
*/ -}}
{{- define "mend.blobStoreMode" -}}
{{- $b := .Values.captureStore.blobStore -}}
{{- if not (kindIs "bool" $b.useDefaultCredentials) -}}
{{ fail "captureStore.blobStore.useDefaultCredentials must be a boolean" }}
{{- end -}}
{{- if and $b.useDefaultCredentials (or $b.credentialsSecret $b.fromObjectBucketClaim.configMap $b.fromObjectBucketClaim.secret) -}}
{{ fail "captureStore.blobStore: useDefaultCredentials cannot be combined with credentialsSecret or fromObjectBucketClaim" }}
{{- end -}}
{{- if and $b.credentialsSecret (or $b.fromObjectBucketClaim.configMap $b.fromObjectBucketClaim.secret) -}}
{{ fail "captureStore.blobStore: credentialsSecret cannot be combined with fromObjectBucketClaim" }}
{{- end -}}
{{- if and $b.fromObjectBucketClaim.secret (not $b.fromObjectBucketClaim.configMap) -}}
{{ fail "captureStore.blobStore.fromObjectBucketClaim.configMap is required with fromObjectBucketClaim.secret" }}
{{- end -}}
{{- if and $b.fromObjectBucketClaim.configMap $b.url -}}
{{ fail "captureStore.blobStore: set fromObjectBucketClaim OR url, not both" }}
{{- else if $b.fromObjectBucketClaim.configMap -}}obc
{{- else if $b.url -}}url
{{- else -}}
{{ fail "captureStore.blobStore: set fromObjectBucketClaim.configMap/secret (a Rook ObjectBucketClaim) or url (s3://<bucket>?endpoint=…)" }}
{{- end -}}
{{- end -}}
{{- /* The `endpoint=` query value of an s3:// blob-store URL (unencoded, as documented). */ -}}
{{- define "mend.blobStoreEndpointOfUrl" -}}
{{- $q := (urlParse .).query -}}
{{- range splitList "&" $q -}}
{{- if hasPrefix "endpoint=" . -}}{{ trimPrefix "endpoint=" . }}{{- end -}}
{{- end -}}
{{- end -}}
{{- /* MEND_BLOB_STORE_PUBLIC_URL: the operator's value, else the same in-cluster endpoint. */ -}}
{{- define "mend.blobStorePublicUrl" -}}
{{- $b := .Values.captureStore.blobStore -}}
{{- if $b.publicUrl -}}{{ $b.publicUrl }}
{{- else if eq (include "mend.blobStoreMode" .) "obc" -}}{{ $b.fromObjectBucketClaim.scheme }}://$(BUCKET_HOST):$(BUCKET_PORT)
{{- else -}}
{{- $endpoint := include "mend.blobStoreEndpointOfUrl" $b.url -}}
{{- if $endpoint -}}{{ $endpoint }}{{- else -}}{{ fail "captureStore.blobStore.publicUrl is required when url carries no endpoint= (an AWS-region bucket)" }}{{- end -}}
{{- end -}}
{{- end -}}
{{- /* The API tier's capture-store env (docs/KUBERNETES.md "Configuration"). */ -}}
{{- define "mend.captureEnv" -}}
{{- $c := .Values.captureStore -}}
{{- if ne $c.sessionStore "captured" -}}
{{ fail (printf "captureStore.sessionStore must be \"captured\" (got %q): the deprecated co-located store is not rendered by this chart" $c.sessionStore) }}
{{- end -}}
{{- $b := $c.blobStore -}}
- { name: MEND_SESSION_STORE, value: captured }
{{- if eq (include "mend.blobStoreMode" .) "obc" }}
# The ObjectBucketClaim's outputs; the URL below is assembled from them at container start.
- name: BUCKET_HOST
  valueFrom: { configMapKeyRef: { name: {{ $b.fromObjectBucketClaim.configMap | quote }}, key: BUCKET_HOST } }
- name: BUCKET_PORT
  valueFrom: { configMapKeyRef: { name: {{ $b.fromObjectBucketClaim.configMap | quote }}, key: BUCKET_PORT } }
- name: BUCKET_NAME
  valueFrom: { configMapKeyRef: { name: {{ $b.fromObjectBucketClaim.configMap | quote }}, key: BUCKET_NAME } }
- name: AWS_ACCESS_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ required "captureStore.blobStore.fromObjectBucketClaim.secret" $b.fromObjectBucketClaim.secret | quote }}, key: AWS_ACCESS_KEY_ID } }
- name: AWS_SECRET_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ $b.fromObjectBucketClaim.secret | quote }}, key: AWS_SECRET_ACCESS_KEY } }
- { name: MEND_BLOB_STORE, value: {{ printf "s3://$(BUCKET_NAME)?endpoint=%s://$(BUCKET_HOST):$(BUCKET_PORT)&region=%s&forcePathStyle=true" $b.fromObjectBucketClaim.scheme $b.fromObjectBucketClaim.region | quote }} }
{{- else }}
{{- if not $b.useDefaultCredentials }}
- name: AWS_ACCESS_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ required "captureStore.blobStore.credentialsSecret is required with captureStore.blobStore.url unless useDefaultCredentials=true" $b.credentialsSecret | quote }}, key: AWS_ACCESS_KEY_ID } }
- name: AWS_SECRET_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ $b.credentialsSecret | quote }}, key: AWS_SECRET_ACCESS_KEY } }
{{- end }}
- { name: MEND_BLOB_STORE, value: {{ $b.url | quote }} }
{{- end }}
- { name: MEND_BLOB_STORE_PUBLIC_URL, value: {{ include "mend.blobStorePublicUrl" . | quote }} }
{{- with $c.multipart.thresholdBytes }}
- { name: MEND_CAPTURE_MULTIPART_THRESHOLD, value: {{ . | quote }} }
{{- end }}
{{- with $c.multipart.partSizeBytes }}
- { name: MEND_CAPTURE_MULTIPART_PART_SIZE, value: {{ . | quote }} }
{{- end }}
{{- with $c.byteQuotaFloorBytes }}
- { name: MEND_CAPTURE_BYTE_QUOTA_FLOOR, value: {{ . | quote }} }
{{- end }}
{{- end -}}
{{- define "mend.validateSessionService" -}}
{{- $c := .Values.sessionChannel -}}
{{- if or (not (regexMatch "^[0-9]+$" (toString $c.port))) (lt (int $c.port) 1) (gt (int $c.port) 65535) -}}
{{ fail "sessionChannel.port must be an integer between 1 and 65535" }}
{{- end -}}
{{- if not (has $c.service.type (list "ClusterIP" "NodePort")) -}}
{{ fail "sessionChannel.service.type must be ClusterIP or NodePort" }}
{{- end -}}
{{- if eq $c.service.type "NodePort" -}}
{{- if or (not (regexMatch "^[0-9]+$" (toString $c.service.nodePort))) (lt (int $c.service.nodePort) 30000) (gt (int $c.service.nodePort) 32767) -}}
{{ fail "sessionChannel.service.nodePort must be an explicit integer between 30000 and 32767 for NodePort" }}
{{- end -}}
{{- else if ne $c.service.nodePort nil -}}
{{ fail "sessionChannel.service.nodePort may only be set with type=NodePort" }}
{{- end -}}
{{- end -}}
{{- define "mend.sessionEndpointUrl" -}}
{{- $c := .Values.sessionChannel -}}
{{- $scheme := ternary "https" "http" $c.tls.enabled -}}
{{- if $c.advertisedUrl -}}
{{- $url := urlParse $c.advertisedUrl -}}
{{- if or (not (has $url.scheme (list "http" "https"))) (empty $url.host) $url.userinfo $url.query $url.fragment (not (has $url.path (list "" "/"))) -}}
{{ fail "sessionChannel.advertisedUrl must be an http(s) origin without credentials, query, fragment or path" }}
{{- end -}}
{{- if ne $url.scheme $scheme -}}
{{ fail "sessionChannel.advertisedUrl scheme must match sessionChannel.tls.enabled (http when false, https when true)" }}
{{- end -}}
{{- $c.advertisedUrl -}}
{{- else -}}
{{ $scheme }}://{{ .Release.Name }}-session.{{ .Release.Namespace }}.svc:{{ $c.port }}
{{- end -}}
{{- end -}}
{{- /* Browser-facing configuration only. Never include API credentials in the web tier. */ -}}
{{- define "mend.browserOriginEnv" -}}
- { name: APP_URL, value: {{ .Values.web.appUrl | quote }} }
{{- with .Values.web.allowedOrigins }}
- { name: MEND_ALLOWED_ORIGINS, value: {{ toJson . | quote }} }
{{- end }}
{{- end -}}
{{- define "mend.commonEnv" -}}
- { name: NODE_ENV, value: production }
- { name: MEND_DEPLOYMENT_MODE, value: kubernetes }
- { name: MEND_STORE_ROOT, value: {{ .Values.store.mountPath | quote }} }
- { name: SEALANT_BASE_URL, value: {{ .Values.sealant.baseUrl | quote }} }
{{ include "mend.browserOriginEnv" . }}
- { name: MEND_VERSION, value: {{ include "mend.tag" . | quote }} }
- name: BETTER_AUTH_SECRET
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: BETTER_AUTH_SECRET } }
- name: SEALANT_SERVICE_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: SEALANT_SERVICE_KEY } }
{{- if .Values.postgres.enabled }}
- name: MEND_DB_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: MEND_DB_PASSWORD } }
- { name: DATABASE_URL, value: "postgres://mend:$(MEND_DB_PASSWORD)@{{ .Release.Name }}-postgres:5432/mend" }
{{- else }}
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ .Values.secrets.existingSecret }}, key: DATABASE_URL } }
{{- end }}
{{- range .Values.extraEnv }}
- { name: {{ .name | quote }}, value: {{ .value | quote }} }
{{- end }}
{{- end -}}
{{- define "mend.serviceBindList" -}}
{{- $out := list -}}
{{- range .Values.serviceHost.bindAddresses -}}
{{- $out = append $out (ternary "$(MEND_POD_IP)" . (eq . "podIP")) -}}
{{- end -}}
{{- join "," $out -}}
{{- end -}}
{{- /* The overlap rule mirrors @mend/network previewDomainOverlap; templates cannot import it.
A preview domain on Mend's own site (one registrable domain, such as previews.example.com beside
mend.example.com) passes here: a template cannot read the Public Suffix List. The API refuses it
at start. */ -}}
{{- define "mend.validatePreview" -}}
{{- if .Values.preview.enabled -}}
{{- $domain := required "preview.domain is required when preview.enabled" .Values.preview.domain -}}
{{- if not (regexMatch "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$" $domain) -}}
{{- fail (printf "preview.domain must be a lowercase DNS name a wildcard certificate can be issued for, such as previews.example.net (got %q)" $domain) -}}
{{- end -}}
{{- $hosts := list (urlParse .Values.web.appUrl).hostname -}}
{{- with .Values.ingress.host }}{{ $hosts = append $hosts . }}{{ end -}}
{{- range .Values.web.allowedOrigins }}{{ $hosts = append $hosts (urlParse .).hostname }}{{ end -}}
{{- range $hosts -}}
{{- if or (eq . $domain) (hasSuffix (printf ".%s" $domain) .) -}}
{{- fail (printf "preview.domain %s holds Mend's host %s (ingress.host, web.appUrl or web.allowedOrigins): previews need a domain that is not Mend's host, above it or under it" $domain .) -}}
{{- end -}}
{{- if hasSuffix (printf ".%s" .) $domain -}}
{{- fail (printf "preview.domain %s is under Mend's host %s (ingress.host, web.appUrl or web.allowedOrigins): previews need a domain that is not Mend's host, above it or under it" $domain .) -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.exposure.mode "public") (not (has "preview-gateway" .Values.exposure.declared)) -}}
{{- fail (printf "exposure.mode is public and previews are on, so the API refuses to start until preview-gateway is declared. Under exposure.mode private first, verify from another network that the wildcard DNS for *.%s points at the ingress controller, that the certificate for *.%s chains to a public root, that https://<label>.%s answers from another network, and that the API Pod's preview port %v answers nothing from outside the cluster. Then add preview-gateway to exposure.declared" $domain $domain $domain .Values.preview.port) -}}
{{- end -}}
{{- if not .Values.preview.ingress.tls.secretName -}}
{{- fail "preview.ingress.tls.secretName is required when preview.enabled: previews are never routed without TLS. A wildcard needs a DNS-01 issuer; the chart installs none" -}}
{{- end -}}
{{- range .Values.extraEnv -}}
{{- if and (eq .name "MEND_PREVIEW_PUBLIC_PORT") (ne (toString .value) "443") -}}
{{- fail (printf "extraEnv sets MEND_PREVIEW_PUBLIC_PORT=%v: the preview Ingress serves 443, and the gateway routes and checks Origin by the port browsers use" .value) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.networkPolicies.enabled (or (not .Values.ingress.controller.namespace) (not .Values.ingress.controller.podLabels)) -}}
{{- fail "preview: set ingress.controller.namespace and ingress.controller.podLabels so NetworkPolicy admits the controller's Pods to the preview gateway, and only them" -}}
{{- end -}}
{{- include "mend.validatePreviewPort" . -}}
{{- end -}}
{{- end -}}

{{- /* The release namespace's NetworkPolicy rule names these ports, so none may be the preview
port: only the controller's rule admits it. */ -}}
{{- define "mend.validatePreviewPort" -}}
{{- $port := int .Values.preview.port -}}
{{- if eq $port 3101 -}}
{{- fail (printf "preview.port %d is the API's own port 3101: choose another port for the preview gateway" $port) -}}
{{- end -}}
{{- if eq $port (int .Values.sessionChannel.port) -}}
{{- fail (printf "preview.port %d is the session channel's port (sessionChannel.port): choose another port for the preview gateway" $port) -}}
{{- end -}}
{{- if and (ge $port (int .Values.serviceHost.portMin)) (le $port (int .Values.serviceHost.portMax)) -}}
{{- fail (printf "preview.port %d is inside the Service host range %v-%v (serviceHost.portMin-portMax), which every Pod in the release namespace reaches: choose a preview port outside it, or move the range" $port .Values.serviceHost.portMin .Values.serviceHost.portMax) -}}
{{- end -}}
{{- end -}}
