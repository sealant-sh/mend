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
{{- else -}}{{ fail "set store.existingClaim or store.create.enabled=true" }}
{{- end -}}
{{- end -}}
{{- /*
The capture store's bucket (captureStore.blobStore): exactly one of an ObjectBucketClaim's
outputs or a plain URL. Returns "obc" or "url".
*/ -}}
{{- define "mend.blobStoreMode" -}}
{{- $b := .Values.captureStore.blobStore -}}
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
- name: AWS_ACCESS_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ required "captureStore.blobStore.credentialsSecret is required with captureStore.blobStore.url" $b.credentialsSecret | quote }}, key: AWS_ACCESS_KEY_ID } }
- name: AWS_SECRET_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ $b.credentialsSecret | quote }}, key: AWS_SECRET_ACCESS_KEY } }
- { name: MEND_BLOB_STORE, value: {{ $b.url | quote }} }
{{- end }}
- { name: MEND_BLOB_STORE_PUBLIC_URL, value: {{ include "mend.blobStorePublicUrl" . | quote }} }
{{- with $c.multipart.thresholdBytes }}
- { name: MEND_CAPTURE_MULTIPART_THRESHOLD, value: {{ . | quote }} }
{{- end }}
{{- with $c.multipart.partSizeBytes }}
- { name: MEND_CAPTURE_MULTIPART_PART_SIZE, value: {{ . | quote }} }
{{- end }}
{{- end -}}
{{- define "mend.sessionEndpointUrl" -}}
{{- if .Values.sessionChannel.tls.enabled -}}https{{- else -}}http{{- end -}}://{{ .Release.Name }}-session.{{ .Release.Namespace }}.svc:{{ .Values.sessionChannel.port }}
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
