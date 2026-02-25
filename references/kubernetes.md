# Kubernetes — Deployment, Helm Charts, and Enterprise Operations

At enterprise scale, services run on Kubernetes. This reference covers the essential K8s manifests, a Helm chart structure, and operational patterns for production-grade deployments.

## Core Kubernetes Manifests

### Namespace

Always deploy services into a dedicated namespace:

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: {service}
  labels:
    environment: production
    team: platform
```

### Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {service}
  namespace: {service}
  labels:
    app: {service}
    version: "{{ .Values.image.tag }}"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: {service}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    metadata:
      labels:
        app: {service}
        version: "{{ .Values.image.tag }}"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/actuator/prometheus"
    spec:
      serviceAccountName: {service}
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: {service}
          image: "{{ .Values.image.registry }}/{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          env:
            - name: SPRING_PROFILES_ACTIVE
              value: "{{ .Values.environment }}"
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: {service}-db-secret
                  key: host
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {service}-db-secret
                  key: password
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "http://otel-collector.observability:4318"
            - name: JAVA_OPTS
              value: "-XX:MaxRAMPercentage=75.0 -XX:+UseZGC -XX:+UseStringDeduplication"
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: 1000m
              memory: 1Gi
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 5
            failureThreshold: 3
          startupProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            failureThreshold: 30
            periodSeconds: 5
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: {service}
      terminationGracePeriodSeconds: 60
```

### Service

```yaml
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: {service}
  namespace: {service}
  labels:
    app: {service}
spec:
  selector:
    app: {service}
  ports:
    - name: http
      port: 80
      targetPort: 8080
      protocol: TCP
  type: ClusterIP
```

### Ingress

```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {service}
  namespace: {service}
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/rate-limit-window: "1m"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - {service}.example.com
      secretName: {service}-tls
  rules:
    - host: {service}.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {service}
                port:
                  number: 80
```

### ConfigMap

```yaml
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {service}-config
  namespace: {service}
data:
  SPRING_PROFILES_ACTIVE: production
  SERVER_PORT: "8080"
  MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE: health,info,prometheus
  LOGGING_LEVEL_ROOT: INFO
```

### HorizontalPodAutoscaler

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {service}
  namespace: {service}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {service}
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 4
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 25
          periodSeconds: 60
```

### PodDisruptionBudget

Ensures rolling updates and node drains don't take down all pods simultaneously:

```yaml
# k8s/pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {service}
  namespace: {service}
spec:
  minAvailable: 2   # always keep at least 2 pods running
  selector:
    matchLabels:
      app: {service}
```

### ServiceAccount and RBAC

```yaml
# k8s/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {service}
  namespace: {service}
  annotations:
    # For AWS EKS — IAM role binding
    eks.amazonaws.com/role-arn: arn:aws:iam::{account-id}:role/{service}-role
automountServiceAccountToken: false
```

---

## Spring Boot — Kubernetes-Ready Configuration

### Liveness and Readiness Probes

Spring Boot 2.3+ exposes dedicated liveness and readiness endpoints:

```yaml
# application.yml
management:
  endpoint:
    health:
      probes:
        enabled: true
      show-details: never   # don't expose internals via health endpoint
      group:
        readiness:
          include: readinessState, db, redis, kafka
        liveness:
          include: livenessState
  health:
    livenessstate:
      enabled: true
    readinessstate:
      enabled: true
```

### Graceful Shutdown

```yaml
# application.yml
server:
  shutdown: graceful    # finish in-flight requests before stopping

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s   # wait up to 30s for in-flight work
```

Pair with `terminationGracePeriodSeconds: 60` in the Deployment spec (must be > `timeout-per-shutdown-phase`).

---

## Helm Chart Structure

Helm packages and templates K8s manifests for repeatable, parameterised deployments.

```
helm/
└── {service}/
    ├── Chart.yaml
    ├── values.yaml
    ├── values-dev.yaml
    ├── values-uat.yaml
    ├── values-prod.yaml
    └── templates/
        ├── _helpers.tpl
        ├── deployment.yaml
        ├── service.yaml
        ├── ingress.yaml
        ├── configmap.yaml
        ├── hpa.yaml
        ├── pdb.yaml
        ├── serviceaccount.yaml
        └── NOTES.txt
```

### Chart.yaml

```yaml
# helm/{service}/Chart.yaml
apiVersion: v2
name: {service}
description: {Service} microservice
type: application
version: 0.1.0
appVersion: "1.0.0"
```

### values.yaml (Defaults)

```yaml
# helm/{service}/values.yaml
replicaCount: 2

image:
  registry: registry.example.com
  repository: {org}/{service}
  tag: latest
  pullPolicy: IfNotPresent

environment: local

service:
  port: 80
  targetPort: 8080

ingress:
  enabled: false
  hostname: {service}.example.com
  tlsEnabled: true
  annotations: {}

resources:
  requests:
    cpu: 250m
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 1Gi

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

env: {}          # extra environment variables as key-value pairs
secrets: {}      # extra environment variables sourced from secrets
```

### values-prod.yaml

```yaml
# helm/{service}/values-prod.yaml
replicaCount: 3

image:
  pullPolicy: Always

environment: prod

ingress:
  enabled: true
  hostname: {service}.example.com

resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: 2000m
    memory: 2Gi

autoscaling:
  minReplicas: 3
  maxReplicas: 20
```

### Helm Commands

```bash
# Lint the chart
helm lint helm/{service}

# Dry-run (see rendered manifests)
helm upgrade --install {service} helm/{service} \
  --values helm/{service}/values-prod.yaml \
  --set image.tag=$IMAGE_TAG \
  --dry-run --debug

# Deploy / upgrade
helm upgrade --install {service} helm/{service} \
  --namespace {service} \
  --create-namespace \
  --values helm/{service}/values-prod.yaml \
  --set image.tag=$IMAGE_TAG \
  --wait \
  --timeout 5m

# Rollback
helm rollback {service} 1 --namespace {service}

# Check history
helm history {service} --namespace {service}
```

---

## CD Workflow — Kubernetes Deploy

```yaml
# .github/workflows/cd.yml (Kubernetes variant)
  deploy-k8s:
    needs: build-and-test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://{service}.example.com

    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/k8s-set-context@v3
        with:
          method: kubeconfig
          kubeconfig: ${{ secrets.KUBECONFIG }}

      - name: Set up Helm
        uses: azure/setup-helm@v4
        with:
          version: 'v3.15.4'

      - name: Deploy via Helm
        run: |
          helm upgrade --install {service} helm/{service} \
            --namespace {service} \
            --create-namespace \
            --values helm/{service}/values-prod.yaml \
            --set image.tag=${{ github.sha }} \
            --wait \
            --timeout 10m

      - name: Verify deployment
        run: |
          kubectl rollout status deployment/{service} -n {service} --timeout=5m
          kubectl get pods -n {service}

      - name: Health check
        run: |
          sleep 15
          curl --fail --retry 10 --retry-delay 5 \
            https://{service}.example.com/actuator/health
```

---

## Secrets Management in Kubernetes

### External Secrets Operator (Recommended for Enterprise)

Sync secrets from Vault or AWS Secrets Manager into K8s secrets:

```yaml
# k8s/external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {service}-db-secret
  namespace: {service}
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  target:
    name: {service}-db-secret
    creationPolicy: Owner
  data:
    - secretKey: host
      remoteRef:
        key: secret/{service}/database
        property: host
    - secretKey: password
      remoteRef:
        key: secret/{service}/database
        property: password
```

### Sealed Secrets (GitOps Friendly)

If storing secrets in Git (encrypted), use Bitnami Sealed Secrets:

```bash
# Encrypt a secret for the cluster
kubeseal --format yaml \
  < k8s/secret-plain.yaml \
  > k8s/secret-sealed.yaml

# The sealed secret is safe to commit to Git
git add k8s/secret-sealed.yaml
```

---

## Resource Sizing Guidelines

| Service Tier | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---|---|---|---|---|
| Light (CRUD) | 100m | 500m | 256Mi | 512Mi |
| Standard | 250m | 1000m | 512Mi | 1Gi |
| Heavy (batch/Kafka) | 500m | 2000m | 1Gi | 2Gi |
| Data-intensive | 1000m | 4000m | 2Gi | 4Gi |

JVM memory sizing: set `XX:MaxRAMPercentage=75.0` and the JVM will use 75% of the container memory limit. Example: 1Gi limit → 768Mi heap.

---

## Multi-Environment Kustomize (Alternative to Helm)

For teams preferring plain YAML with overlays over templating:

```
k8s/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   └── configmap.yaml
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml
    │   └── patch-replicas.yaml
    ├── uat/
    │   ├── kustomization.yaml
    │   └── patch-resources.yaml
    └── prod/
        ├── kustomization.yaml
        ├── patch-replicas.yaml
        └── patch-resources.yaml
```

```yaml
# k8s/overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: {service}-prod
resources:
  - ../../base
patches:
  - path: patch-replicas.yaml
  - path: patch-resources.yaml
images:
  - name: {service}
    newTag: "${IMAGE_TAG}"
```

```bash
# Apply prod overlay
kubectl apply -k k8s/overlays/prod

# Preview
kubectl kustomize k8s/overlays/prod
```
