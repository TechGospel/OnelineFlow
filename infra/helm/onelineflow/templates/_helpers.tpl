{{- define "onelineflow.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "onelineflow.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "onelineflow.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "onelineflow.labels" -}}
app.kubernetes.io/name: {{ include "onelineflow.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "onelineflow.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{/*
Environment shared by every workload.

Non-secret values are templated inline; secrets come wholesale from an
externally managed Secret via envFrom. The chart never renders a secret value,
so `helm template` output is safe to commit or paste into a ticket.
*/}}
{{- define "onelineflow.env" -}}
{{- range $key, $value := .Values.config }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
- name: POD_NAME
  valueFrom:
    fieldRef: { fieldPath: metadata.name }
{{- end -}}

{{- define "onelineflow.podSpec" -}}
{{- with .root.Values.imagePullSecrets }}
imagePullSecrets: {{- toYaml . | nindent 2 }}
{{- end }}
serviceAccountName: {{ include "onelineflow.fullname" .root }}
securityContext: {{- toYaml .root.Values.podSecurityContext | nindent 2 }}
containers:
  - name: {{ .name }}
    image: {{ include "onelineflow.image" .root }}
    imagePullPolicy: {{ .root.Values.image.pullPolicy }}
    securityContext: {{- toYaml .root.Values.containerSecurityContext | nindent 6 }}
    command: {{ toYaml .command | nindent 6 }}
    env:
      {{- include "onelineflow.env" .root | nindent 6 }}
      {{- with .extraEnv }}{{- toYaml . | nindent 6 }}{{- end }}
    envFrom:
      - secretRef:
          name: {{ .root.Values.existingSecret }}
    ports:
      - name: metrics
        containerPort: {{ .root.Values.config.METRICS_PORT | int }}
      {{- if .httpPort }}
      - name: http
        containerPort: {{ .httpPort }}
      {{- end }}
    resources: {{- toYaml .resources | nindent 6 }}
    livenessProbe:
      httpGet: { path: /healthz, port: {{ if .httpPort }}http{{ else }}metrics{{ end }} }
      initialDelaySeconds: 15
      periodSeconds: 20
      # Generous: a liveness restart mid-post turns a known outcome into an
      # unknown one, which is the expensive state to recover from.
      failureThreshold: 5
    readinessProbe:
      httpGet: { path: {{ if .httpPort }}/readyz{{ else }}/healthz{{ end }}, port: {{ if .httpPort }}http{{ else }}metrics{{ end }} }
      initialDelaySeconds: 5
      periodSeconds: 10
    volumeMounts:
      - name: tmp
        mountPath: /tmp
volumes:
  - name: tmp
    emptyDir: {}
# Must exceed the worker's own grace period (25s) so it exits on its terms
# rather than by SIGKILL mid-write.
terminationGracePeriodSeconds: 45
{{- end -}}
