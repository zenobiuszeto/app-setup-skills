# Observability — OpenTelemetry, Micrometer, Prometheus, Grafana

This reference covers the full observability stack: distributed tracing (OpenTelemetry), metrics (Micrometer → Prometheus), and dashboards (Grafana).

## OpenTelemetry — Distributed Tracing

### Auto-Instrumentation (Recommended Start)

The simplest approach — attach the OTel Java agent and get traces for Spring MVC, JDBC, Redis, Kafka, HTTP clients automatically:

```dockerfile
# Add OTel agent to Docker image
ADD https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar /opt/otel-agent.jar

ENV JAVA_OPTS="-javaagent:/opt/otel-agent.jar"
ENV OTEL_SERVICE_NAME=order-service
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
ENV OTEL_TRACES_SAMPLER=parentbased_traceidratio
ENV OTEL_TRACES_SAMPLER_ARG=0.1
```

### Spring Boot Starter (Library Approach)

For more control without the Java agent, use the Spring Boot OTel starter:

```groovy
// build.gradle
implementation platform('io.opentelemetry.instrumentation:opentelemetry-instrumentation-bom:2.10.0')
implementation 'io.opentelemetry.instrumentation:opentelemetry-spring-boot-starter'
```

```yaml
# application.yml
management:
  tracing:
    sampling:
      probability: 1.0  # 100% in dev, lower in prod (0.1 = 10%)

otel:
  exporter:
    otlp:
      endpoint: ${OTEL_EXPORTER_OTLP_ENDPOINT:http://localhost:4318}
  resource:
    attributes:
      service.name: ${spring.application.name}
      deployment.environment: ${SPRING_PROFILES_ACTIVE:local}
```

### Manual Spans

For business-critical operations that deserve their own trace spans:

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class PaymentService {

    private final Tracer tracer;
    private final PaymentGatewayClient gateway;

    public PaymentResult processPayment(PaymentRequest request) {
        Span span = tracer.spanBuilder("payment.process")
                .setAttribute("payment.amount", request.getAmount().doubleValue())
                .setAttribute("payment.currency", request.getCurrency())
                .setAttribute("payment.method", request.getMethod().name())
                .startSpan();

        try (Scope scope = span.makeCurrent()) {
            var result = gateway.charge(request);

            span.setAttribute("payment.transactionId", result.getTransactionId());
            span.setAttribute("payment.status", result.getStatus().name());

            if (result.isDeclined()) {
                span.setStatus(StatusCode.ERROR, "Payment declined: " + result.getReason());
            }

            return result;
        } catch (Exception e) {
            span.setStatus(StatusCode.ERROR, e.getMessage());
            span.recordException(e);
            throw e;
        } finally {
            span.end();
        }
    }
}
```

### Using @WithSpan Annotation

For simpler cases:

```java
@WithSpan("inventory.reserve")
public void reserveStock(
        @SpanAttribute("order.id") UUID orderId,
        @SpanAttribute("item.count") int itemCount) {
    // Method body is automatically wrapped in a span
}
```

### Trace Context Propagation

Traces propagate automatically through:
- HTTP headers (W3C `traceparent` / B3)
- Kafka headers (auto-instrumented)
- gRPC metadata

For custom propagation (e.g., in async tasks):

```java
Context currentContext = Context.current();

executor.submit(currentContext.wrap(() -> {
    // Trace context is preserved here
    processAsync();
}));
```

### OTel Collector Config

```yaml
# infra/otel-collector-config.yml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 1024
  memory_limiter:
    check_interval: 1s
    limit_mib: 512

exporters:
  # Export to Jaeger, Zipkin, or any OTLP-compatible backend
  otlp:
    endpoint: jaeger:4317
    tls:
      insecure: true
  # Also export to Prometheus for exemplars
  prometheus:
    endpoint: 0.0.0.0:8889

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
```

---

## Micrometer — Application Metrics

### Built-in Metrics

Spring Boot Actuator + Micrometer gives you dozens of metrics out of the box:
- `http.server.requests` — request count, latency histogram by URI, method, status
- `jvm.memory.used`, `jvm.gc.pause` — JVM health
- `hikaricp.connections.active` — connection pool utilization
- `spring.kafka.listener` — consumer lag, processing time
- `cache.gets`, `cache.puts` — Redis cache hit/miss rates

### Custom Business Metrics

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderService {

    private final MeterRegistry meterRegistry;
    private final OrderRepository orderRepository;

    private Counter ordersCreatedCounter;
    private Timer orderProcessingTimer;
    private AtomicInteger activeOrdersGauge;

    @PostConstruct
    void initMetrics() {
        ordersCreatedCounter = Counter.builder("orders.created")
                .description("Total orders created")
                .tag("service", "order-service")
                .register(meterRegistry);

        orderProcessingTimer = Timer.builder("orders.processing.duration")
                .description("Time to process an order")
                .publishPercentiles(0.5, 0.95, 0.99)
                .publishPercentileHistogram()
                .register(meterRegistry);

        activeOrdersGauge = meterRegistry.gauge("orders.active",
                new AtomicInteger(0));
    }

    public OrderResponse createOrder(CreateOrderRequest request) {
        return orderProcessingTimer.record(() -> {
            var order = processOrderInternal(request);
            ordersCreatedCounter.increment();
            activeOrdersGauge.incrementAndGet();
            return toResponse(order);
        });
    }

    // Distribution summary for order values
    public void recordOrderValue(BigDecimal total) {
        DistributionSummary.builder("orders.value")
                .description("Order total value distribution")
                .baseUnit("USD")
                .publishPercentiles(0.5, 0.9, 0.99)
                .register(meterRegistry)
                .record(total.doubleValue());
    }
}
```

### Tagging Conventions

Use consistent, low-cardinality tags:

```java
// Good — bounded set of values
.tag("order.status", status.name())     // CREATED, PROCESSING, COMPLETED, FAILED
.tag("payment.method", "CREDIT_CARD")   // CREDIT_CARD, DEBIT, WALLET

// Bad — unbounded cardinality (will blow up Prometheus)
.tag("order.id", orderId)               // NEVER — millions of unique values
.tag("user.email", email)               // NEVER — PII and unbounded
```

---

## Prometheus Configuration

### prometheus.yml

```yaml
# infra/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'spring-boot-apps'
    metrics_path: /actuator/prometheus
    scrape_interval: 10s
    static_configs:
      - targets:
          - 'app:8080'
        labels:
          environment: 'local'

    # For multiple instances / service discovery:
    # dns_sd_configs:
    #   - names: ['tasks.app']
    #     type: A
    #     port: 8080

  - job_name: 'otel-collector'
    static_configs:
      - targets: ['otel-collector:8889']
```

### Key Prometheus Queries

```promql
# Request rate (per second)
rate(http_server_requests_seconds_count{uri!~"/actuator.*"}[5m])

# p99 latency
histogram_quantile(0.99, rate(http_server_requests_seconds_bucket[5m]))

# Error rate
sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
/ sum(rate(http_server_requests_seconds_count[5m]))

# JVM heap usage
jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"}

# HikariCP active connections
hikaricp_connections_active

# Kafka consumer lag (via OTel or JMX)
kafka_consumer_records_lag_max

# Order processing p95
histogram_quantile(0.95, rate(orders_processing_duration_seconds_bucket[5m]))

# Cache hit rate
sum(rate(cache_gets_total{result="hit"}[5m]))
/ sum(rate(cache_gets_total[5m]))
```

---

## Grafana Dashboards

### Dashboard Provisioning

Auto-provision dashboards via Docker Compose volume:

```yaml
# docker-compose.yml addition
grafana:
  volumes:
    - ./infra/grafana/provisioning:/etc/grafana/provisioning
    - ./infra/grafana/dashboards:/var/lib/grafana/dashboards
```

```yaml
# infra/grafana/provisioning/datasources/prometheus.yml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

```yaml
# infra/grafana/provisioning/dashboards/dashboards.yml
apiVersion: 1
providers:
  - name: 'default'
    orgId: 1
    folder: ''
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

### Recommended Dashboard Panels

**Service Overview Dashboard:**

| Panel | Metric | Visualization |
|---|---|---|
| Request Rate | `rate(http_server_requests_seconds_count[5m])` | Time series |
| Error Rate (%) | 5xx / total | Stat + threshold |
| p50 / p95 / p99 Latency | `histogram_quantile` | Time series (3 queries) |
| Active Requests | `http_server_requests_seconds_active_count` | Gauge |

**JVM Dashboard:**

| Panel | Metric | Visualization |
|---|---|---|
| Heap Usage | `jvm_memory_used_bytes{area="heap"}` | Time series |
| GC Pause Duration | `jvm_gc_pause_seconds_sum` | Time series |
| Thread Count | `jvm_threads_live_threads` | Stat |
| CPU Usage | `process_cpu_usage` | Gauge |

**Business Dashboard:**

| Panel | Metric | Visualization |
|---|---|---|
| Orders/sec | `rate(orders_created_total[5m])` | Time series |
| Order Processing Time | `orders_processing_duration_seconds` | Heatmap |
| Cache Hit Rate | `cache_gets hit / total` | Gauge |
| Kafka Consumer Lag | `kafka_consumer_records_lag_max` | Time series |

### Alerting Rules

```yaml
# infra/grafana/provisioning/alerting/rules.yml (or via Prometheus alertmanager)
groups:
  - name: service-alerts
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
          / sum(rate(http_server_requests_seconds_count[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Error rate above 5% for 5 minutes"

      - alert: HighLatency
        expr: |
          histogram_quantile(0.99, rate(http_server_requests_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "p99 latency above 2 seconds"

      - alert: KafkaConsumerLag
        expr: kafka_consumer_records_lag_max > 10000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Kafka consumer lag exceeds 10k messages"
```

---

## Logging + Tracing Correlation

Link logs to traces by putting the trace ID in MDC:

```yaml
# application.yml
logging:
  pattern:
    console: "%d{ISO8601} [%thread] [traceId=%X{traceId} spanId=%X{spanId}] %-5level %logger{36} - %msg%n"
```

The Spring Boot OTel starter automatically populates `traceId` and `spanId` in MDC. With the Java agent, add:

```bash
-Dotel.instrumentation.logback-mdc.enabled=true
```

This lets you click a trace in Jaeger/Tempo and jump to the corresponding log lines in your log aggregator (Loki, ELK, etc.).
