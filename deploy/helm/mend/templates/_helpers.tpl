{{- define "mend.tag" -}}{{ .Values.image.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "mend.image" -}}{{ .Values.image.repository }}:{{ include "mend.tag" . }}{{- end -}}
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
{{- define "mend.storeClaim" -}}{{ if .Values.store.create.enabled }}{{ .Release.Name }}-store{{ else }}{{ required "store.existingClaim is required" .Values.store.existingClaim }}{{ end }}{{- end -}}
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
