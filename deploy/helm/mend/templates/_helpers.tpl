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
{{- define "mend.commonEnv" -}}
- { name: NODE_ENV, value: production }
- { name: MEND_DEPLOYMENT_MODE, value: kubernetes }
- { name: MEND_STORE_ROOT, value: {{ .Values.store.mountPath | quote }} }
- { name: SEALANT_BASE_URL, value: {{ .Values.sealant.baseUrl | quote }} }
- { name: APP_URL, value: {{ .Values.web.appUrl | quote }} }
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
