# Microservices Design Patterns — Resilience, Sagas, and In-Memory Database

This reference covers the most important microservices resilience patterns (Circuit Breaker, Retry, Rate Limiter, Bulkhead), the Saga distributed-transaction pattern, and in-memory database usage for testing and local development.

## Resilience4j — Circuit Breaker, Retry, Rate Limiter, Bulkhead

### Dependencies

```groovy
// build.gradle
implementation 'org.springframework.boot:spring-boot-starter-aop'  // required for annotations
implementation 'io.github.resilience4j:resilience4j-spring-boot3:2.2.0'
implementation 'io.github.resilience4j:resilience4j-micrometer:2.2.0'  // exposes metrics to Prometheus
```

### Circuit Breaker

The Circuit Breaker prevents cascading failures by "opening" after a threshold of failures and rejecting calls fast during the recovery window.

**States:**
- **CLOSED** — normal operation; calls pass through.
- **OPEN** — threshold exceeded; calls fail fast with `CallNotPermittedException`.
- **HALF_OPEN** — probe phase; a limited number of test calls decide whether to close or re-open.

#### Configuration

```yaml
# application.yml
resilience4j:
  circuitbreaker:
    instances:
      order-service:
        slidingWindowType: COUNT_BASED       # or TIME_BASED
        slidingWindowSize: 10                # last 10 calls
        minimumNumberOfCalls: 5              # minimum before evaluation
        failureRateThreshold: 50             # open when ≥50% fail
        slowCallDurationThreshold: 2s        # calls >2s count as slow
        slowCallRateThreshold: 80            # open when ≥80% are slow
        waitDurationInOpenState: 30s         # stay OPEN for 30s before probing
        permittedNumberOfCallsInHalfOpenState: 3
        automaticTransitionFromOpenToHalfOpenEnabled: true
        recordExceptions:
          - java.io.IOException
          - java.util.concurrent.TimeoutException
          - feign.FeignException
        ignoreExceptions:
          - com.{org}.{service}.exception.ResourceNotFoundException
```

#### Usage

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderServiceClient {

    private final RestClient orderServiceRestClient;

    @CircuitBreaker(name = "order-service", fallbackMethod = "getOrderFallback")
    public OrderResponse getOrder(UUID orderId) {
        return orderServiceRestClient.get()
                .uri("/orders/{id}", orderId)
                .retrieve()
                .body(OrderResponse.class);
    }

    // Fallback must have the same signature + a Throwable as the last parameter
    private OrderResponse getOrderFallback(UUID orderId, Throwable ex) {
        log.warn("Circuit breaker fallback triggered for orderId={} cause={}", orderId, ex.getMessage());
        // Return a cached/degraded response or throw a business exception
        throw new ServiceUnavailableException("Order service is temporarily unavailable");
    }
}
```

#### Listening to Circuit Breaker Events

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class CircuitBreakerEventListener {

    private final CircuitBreakerRegistry circuitBreakerRegistry;

    @PostConstruct
    public void registerListeners() {
        circuitBreakerRegistry.circuitBreaker("order-service")
                .getEventPublisher()
                .onStateTransition(event -> log.warn(
                        "Circuit breaker '{}' state transition: {} -> {}",
                        event.getCircuitBreakerName(),
                        event.getStateTransition().getFromState(),
                        event.getStateTransition().getToState()));
    }
}
```

---

### Retry

Automatically retries failed calls with configurable backoff.

#### Configuration

```yaml
resilience4j:
  retry:
    instances:
      order-service:
        maxAttempts: 3
        waitDuration: 500ms
        enableExponentialBackoff: true
        exponentialBackoffMultiplier: 2       # 500ms → 1000ms → 2000ms
        exponentialMaxWaitDuration: 10s
        retryExceptions:
          - java.io.IOException
          - java.util.concurrent.TimeoutException
        ignoreExceptions:
          - com.{org}.{service}.exception.ResourceNotFoundException
          - com.{org}.{service}.exception.ValidationException
```

#### Usage

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class InventoryServiceClient {

    private final RestClient inventoryRestClient;

    // Stack @Retry inside @CircuitBreaker: retry first, trip breaker after repeated failures
    @Retry(name = "order-service", fallbackMethod = "reserveStockFallback")
    @CircuitBreaker(name = "order-service")
    public void reserveStock(UUID orderId, List<StockReservation> items) {
        inventoryRestClient.post()
                .uri("/stock/reserve")
                .body(new ReserveStockRequest(orderId, items))
                .retrieve()
                .toBodilessEntity();
    }

    private void reserveStockFallback(UUID orderId, List<StockReservation> items, Throwable ex) {
        log.error("Stock reservation failed after retries orderId={}", orderId, ex);
        throw new StockUnavailableException("Unable to reserve stock for order " + orderId);
    }
}
```

---

### Rate Limiter

Limits the number of calls a service is allowed to make in a time window — useful to protect upstream services.

#### Configuration

```yaml
resilience4j:
  ratelimiter:
    instances:
      payment-service:
        limitForPeriod: 100          # max 100 calls
        limitRefreshPeriod: 1s       # per second
        timeoutDuration: 0           # fail immediately if rate exceeded (0 = no wait)
```

#### Usage

```java
@RateLimiter(name = "payment-service", fallbackMethod = "chargeRateLimitedFallback")
public PaymentResult charge(PaymentRequest request) {
    return paymentGatewayClient.charge(request);
}

private PaymentResult chargeRateLimitedFallback(PaymentRequest request, RequestNotPermitted ex) {
    throw new RateLimitExceededException("Payment rate limit exceeded — please retry later");
}
```

---

### Bulkhead

Limits the number of concurrent calls to isolate failures and prevent thread exhaustion.

#### Configuration

```yaml
resilience4j:
  bulkhead:
    instances:
      notification-service:
        maxConcurrentCalls: 20
        maxWaitDuration: 100ms   # time to wait for a permit before rejecting
```

#### Usage

```java
@Bulkhead(name = "notification-service", fallbackMethod = "sendNotificationFallback")
public void sendNotification(NotificationRequest request) {
    notificationClient.send(request);
}

private void sendNotificationFallback(NotificationRequest request, BulkheadFullException ex) {
    log.warn("Bulkhead full — dropping notification for userId={}", request.getUserId());
    // Fire-and-forget: log and continue, don't fail the main flow
}
```

---

### Combining Patterns

Recommended annotation ordering for a single method (inner to outer: Retry → CircuitBreaker → RateLimiter → Bulkhead → TimeLimiter):

```java
@TimeLimiter(name = "order-service")
@Bulkhead(name = "order-service")
@CircuitBreaker(name = "order-service", fallbackMethod = "fallback")
@Retry(name = "order-service")
@RateLimiter(name = "order-service")
public CompletableFuture<OrderResponse> getOrderAsync(UUID orderId) {
    return CompletableFuture.supplyAsync(() ->
        orderServiceRestClient.get()
            .uri("/orders/{id}", orderId)
            .retrieve()
            .body(OrderResponse.class));
}
```

### Resilience4j Metrics (Micrometer)

With `resilience4j-micrometer` on the classpath, the following metrics are automatically exported to Prometheus:

```promql
# Circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)
resilience4j_circuitbreaker_state{name="order-service"}

# Failure rate
resilience4j_circuitbreaker_failure_rate{name="order-service"}

# Call counts by outcome
resilience4j_circuitbreaker_calls_seconds_count{name="order-service", kind="successful"}
resilience4j_circuitbreaker_calls_seconds_count{name="order-service", kind="failed"}

# Retry attempts
resilience4j_retry_calls_total{name="order-service", kind="successful_without_retry"}
resilience4j_retry_calls_total{name="order-service", kind="successful_with_retry"}
resilience4j_retry_calls_total{name="order-service", kind="failed_with_retry"}
```

---

## Saga Pattern — Distributed Transactions

Use the Saga pattern when you need atomicity across multiple microservices without distributed locks or 2PC. Each step in the saga has a compensating transaction that undoes it if a later step fails.

### Choreography-Based Saga (Kafka)

Services react to domain events. No central coordinator — each service listens for events and emits new ones. Simpler to implement but harder to track flow.

**Flow example — Place Order saga:**

```
OrderService  ──[OrderCreated]──►  InventoryService
                                        │
                              [StockReserved] or [StockReservationFailed]
                                        │
                                   PaymentService
                                        │
                              [PaymentProcessed] or [PaymentFailed]
                                        │
                                   OrderService (finalises or compensates)
```

#### Event Definitions

```java
// model/event/OrderCreatedEvent.java
public record OrderCreatedEvent(
    UUID orderId,
    UUID customerId,
    List<OrderItem> items,
    BigDecimal total,
    Instant occurredAt
) {}

// model/event/StockReservedEvent.java
public record StockReservedEvent(
    UUID orderId,
    List<StockReservation> reservations,
    Instant occurredAt
) {}

// model/event/StockReservationFailedEvent.java
public record StockReservationFailedEvent(
    UUID orderId,
    String reason,
    Instant occurredAt
) {}

// model/event/PaymentProcessedEvent.java
public record PaymentProcessedEvent(
    UUID orderId,
    String transactionId,
    Instant occurredAt
) {}

// model/event/PaymentFailedEvent.java
public record PaymentFailedEvent(
    UUID orderId,
    String reason,
    Instant occurredAt
) {}
```

#### OrderService — emits event, listens for final outcome

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderService {

    private final OrderRepository orderRepository;
    private final KafkaTemplate<String, Object> kafkaTemplate;

    @Transactional
    public OrderResponse placeOrder(CreateOrderRequest request) {
        var order = Order.builder()
                .customerId(request.customerId())
                .items(toItems(request.items()))
                .status(OrderStatus.PENDING)
                .build();
        orderRepository.save(order);

        kafkaTemplate.send("order.created", order.getId().toString(),
                new OrderCreatedEvent(order.getId(), order.getCustomerId(),
                        order.getItems(), order.getTotal(), Instant.now()));

        log.info("Order placed sagaStep=1 orderId={}", order.getId());
        return toResponse(order);
    }

    @KafkaListener(topics = "payment.processed", groupId = "order-service")
    @Transactional
    public void onPaymentProcessed(PaymentProcessedEvent event) {
        orderRepository.findById(event.orderId()).ifPresent(order -> {
            order.setStatus(OrderStatus.CONFIRMED);
            orderRepository.save(order);
            log.info("Order confirmed sagaStep=complete orderId={}", order.getId());
        });
    }

    @KafkaListener(topics = "payment.failed", groupId = "order-service")
    @Transactional
    public void onPaymentFailed(PaymentFailedEvent event) {
        orderRepository.findById(event.orderId()).ifPresent(order -> {
            order.setStatus(OrderStatus.FAILED);
            orderRepository.save(order);
            log.warn("Order saga failed orderId={} reason={}", order.getId(), event.reason());
        });
    }

    @KafkaListener(topics = "stock.reservation.failed", groupId = "order-service")
    @Transactional
    public void onStockReservationFailed(StockReservationFailedEvent event) {
        orderRepository.findById(event.orderId()).ifPresent(order -> {
            order.setStatus(OrderStatus.FAILED);
            orderRepository.save(order);
            log.warn("Order saga compensating orderId={} reason={}", order.getId(), event.reason());
        });
    }
}
```

#### InventoryService — listens, reserves stock, emits result

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class InventoryService {

    private final StockRepository stockRepository;
    private final KafkaTemplate<String, Object> kafkaTemplate;

    @KafkaListener(topics = "order.created", groupId = "inventory-service")
    @Transactional
    public void onOrderCreated(OrderCreatedEvent event) {
        try {
            var reservations = reserveItems(event.orderId(), event.items());
            kafkaTemplate.send("stock.reserved", event.orderId().toString(),
                    new StockReservedEvent(event.orderId(), reservations, Instant.now()));
            log.info("Stock reserved sagaStep=2 orderId={}", event.orderId());
        } catch (InsufficientStockException ex) {
            kafkaTemplate.send("stock.reservation.failed", event.orderId().toString(),
                    new StockReservationFailedEvent(event.orderId(), ex.getMessage(), Instant.now()));
            log.warn("Stock reservation failed orderId={} reason={}", event.orderId(), ex.getMessage());
        }
    }

    private List<StockReservation> reserveItems(UUID orderId, List<OrderItem> items) {
        // lock stock rows, decrement available quantity, return reservation records
        return items.stream().map(item -> {
            var stock = stockRepository.findBySkuWithLock(item.getSku())
                    .orElseThrow(() -> new InsufficientStockException("SKU not found: " + item.getSku()));
            if (stock.getAvailable() < item.getQuantity()) {
                throw new InsufficientStockException("Insufficient stock for SKU: " + item.getSku());
            }
            stock.setAvailable(stock.getAvailable() - item.getQuantity());
            stock.setReserved(stock.getReserved() + item.getQuantity());
            stockRepository.save(stock);
            return new StockReservation(item.getSku(), item.getQuantity());
        }).toList();
    }
}
```

---

### Orchestration-Based Saga (Explicit Coordinator)

A central saga orchestrator holds the state machine and issues commands to each participant. Easier to reason about and monitor; good for complex, long-running flows.

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class PlaceOrderSagaOrchestrator {

    private final SagaStateRepository sagaStateRepository;
    private final KafkaTemplate<String, Object> kafkaTemplate;

    public void start(UUID orderId) {
        var state = SagaState.builder()
                .sagaId(orderId)
                .currentStep(SagaStep.RESERVE_STOCK)
                .status(SagaStatus.IN_PROGRESS)
                .build();
        sagaStateRepository.save(state);

        kafkaTemplate.send("commands.reserve-stock",
                orderId.toString(), new ReserveStockCommand(orderId));
        log.info("Saga started sagaId={} step=RESERVE_STOCK", orderId);
    }

    @KafkaListener(topics = "events.stock-reserved", groupId = "saga-orchestrator")
    @Transactional
    public void onStockReserved(StockReservedEvent event) {
        var state = sagaStateRepository.findBySagaId(event.orderId()).orElseThrow();
        state.setCurrentStep(SagaStep.PROCESS_PAYMENT);
        sagaStateRepository.save(state);

        kafkaTemplate.send("commands.process-payment",
                event.orderId().toString(), new ProcessPaymentCommand(event.orderId()));
        log.info("Saga advancing sagaId={} step=PROCESS_PAYMENT", event.orderId());
    }

    @KafkaListener(topics = "events.payment-processed", groupId = "saga-orchestrator")
    @Transactional
    public void onPaymentProcessed(PaymentProcessedEvent event) {
        var state = sagaStateRepository.findBySagaId(event.orderId()).orElseThrow();
        state.setCurrentStep(SagaStep.COMPLETE);
        state.setStatus(SagaStatus.COMPLETED);
        sagaStateRepository.save(state);

        kafkaTemplate.send("commands.confirm-order",
                event.orderId().toString(), new ConfirmOrderCommand(event.orderId()));
        log.info("Saga completed sagaId={}", event.orderId());
    }

    @KafkaListener(topics = "events.payment-failed", groupId = "saga-orchestrator")
    @Transactional
    public void onPaymentFailed(PaymentFailedEvent event) {
        compensate(event.orderId(), SagaStep.PROCESS_PAYMENT, event.reason());
    }

    @KafkaListener(topics = "events.stock-reservation-failed", groupId = "saga-orchestrator")
    @Transactional
    public void onStockReservationFailed(StockReservationFailedEvent event) {
        compensate(event.orderId(), SagaStep.RESERVE_STOCK, event.reason());
    }

    private void compensate(UUID sagaId, SagaStep failedStep, String reason) {
        var state = sagaStateRepository.findBySagaId(sagaId).orElseThrow();
        state.setStatus(SagaStatus.COMPENSATING);
        sagaStateRepository.save(state);
        log.warn("Saga compensating sagaId={} failedStep={} reason={}", sagaId, failedStep, reason);

        // Issue compensation commands in reverse order
        if (failedStep.ordinal() > SagaStep.RESERVE_STOCK.ordinal()) {
            kafkaTemplate.send("commands.release-stock",
                    sagaId.toString(), new ReleaseStockCommand(sagaId));
        }
        kafkaTemplate.send("commands.cancel-order",
                sagaId.toString(), new CancelOrderCommand(sagaId, reason));
    }
}
```

#### Saga State Entity

```java
@Entity
@Table(name = "saga_state")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SagaState {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false, unique = true)
    private UUID sagaId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private SagaStep currentStep;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private SagaStatus status;

    @Column(columnDefinition = "TEXT")
    private String failureReason;

    private Instant createdAt;
    private Instant updatedAt;

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        updatedAt = createdAt;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }
}

public enum SagaStep { RESERVE_STOCK, PROCESS_PAYMENT, COMPLETE }
public enum SagaStatus { IN_PROGRESS, COMPLETED, COMPENSATING, FAILED }
```

### Choosing Choreography vs Orchestration

| Factor | Choreography | Orchestration |
|---|---|---|
| Complexity | Low — each service is autonomous | Higher — central coordinator needed |
| Observability | Hard — flow is implicit across services | Easy — state is in one place |
| Coupling | Loose (only events) | Moderate (coordinator knows all steps) |
| Best for | Simple 2–3 step flows | Complex multi-step or long-running flows |
| Testing | Harder — need full Kafka setup | Easier — test orchestrator in isolation |

---

## In-Memory Database (H2)

Use H2 for unit and integration tests that need a real SQL database without spinning up Docker. For production-like integration tests, prefer Testcontainers with a real PostgreSQL image.

### Dependencies

```groovy
// build.gradle
testRuntimeOnly 'com.h2database:h2'  // already included transitively via spring-boot-starter-test
```

### Configuration for Tests

```yaml
# src/test/resources/application-test.yml
spring:
  datasource:
    url: jdbc:h2:mem:testdb;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=FALSE;MODE=PostgreSQL
    driver-class-name: org.h2.Driver
    username: sa
    password:
  jpa:
    hibernate:
      ddl-auto: create-drop   # schema from Flyway or Hibernate for tests
    database-platform: org.hibernate.dialect.H2Dialect
  flyway:
    enabled: true
    locations: classpath:db/migration, classpath:db/testdata
    # Use PostgreSQL-compatible H2 mode so Flyway scripts run unchanged
```

Use `MODE=PostgreSQL` in the H2 URL — this enables PostgreSQL-compatible syntax (e.g., `gen_random_uuid()`, `ILIKE`) so the same Flyway migration scripts that run against real Postgres also run against H2.

### Activating in Tests

```java
@SpringBootTest
@ActiveProfiles("test")
@Transactional  // rolls back after each test
class OrderServiceIntegrationTest {

    @Autowired
    private OrderService orderService;

    @Autowired
    private OrderRepository orderRepository;

    @Test
    void shouldCreateOrderAndPersistToDatabase() {
        var request = new CreateOrderRequest(UUID.randomUUID(), List.of(
                new OrderItemRequest("SKU-001", 2, new BigDecimal("19.99"))
        ), null);

        var response = orderService.createOrder(request);

        assertThat(response.id()).isNotNull();
        assertThat(orderRepository.findById(response.id())).isPresent();
    }
}
```

### Local Profile with H2 Console

For rapid local iteration without Docker:

```yaml
# src/main/resources/application-local.yml (H2 variant — alternative to docker-compose)
spring:
  datasource:
    url: jdbc:h2:mem:localdb;DB_CLOSE_DELAY=-1;MODE=PostgreSQL
    driver-class-name: org.h2.Driver
    username: sa
    password:
  h2:
    console:
      enabled: true       # accessible at http://localhost:8080/h2-console
      path: /h2-console
  jpa:
    hibernate:
      ddl-auto: create-drop
```

> **Note:** Disable the H2 console in non-local profiles. It is a development tool only. The `spring.h2.console.enabled` property defaults to `false` and is only enabled here for the `local` profile.

### Test Data Seeding

Place SQL seed scripts in `src/test/resources/db/testdata/`:

```sql
-- src/test/resources/db/testdata/V900__test_seed_orders.sql
INSERT INTO orders (id, customer_id, status, total, created_at, updated_at)
VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', '11111111-1111-1111-1111-111111111111', 'CONFIRMED', 99.99, now(), now()),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', '22222222-2222-2222-2222-222222222222', 'PENDING',  49.50, now(), now());
```

Or use Spring's `@Sql` annotation for per-test control:

```java
@Test
@Sql(scripts = "/db/testdata/seed-orders.sql",
     executionPhase = Sql.ExecutionPhase.BEFORE_TEST_METHOD)
@Sql(scripts = "/db/testdata/cleanup-orders.sql",
     executionPhase = Sql.ExecutionPhase.AFTER_TEST_METHOD)
void shouldReturnPagedOrdersForCustomer() { ... }
```

### H2 vs Testcontainers Decision Guide

| Scenario | Recommendation |
|---|---|
| Fast unit / slice tests (`@DataJpaTest`) | H2 — no Docker needed, millisecond startup |
| Full integration test matching prod DB | Testcontainers (PostgreSQL) — dialect parity |
| CI without Docker daemon available | H2 |
| Testing PostgreSQL-specific features (JSONB, arrays, advisory locks) | Testcontainers only |

For `@DataJpaTest` specifically, Spring Boot auto-configures H2 when it is on the test classpath — no manual configuration needed:

```java
@DataJpaTest           // auto-configures H2 in-memory, Flyway, and Spring Data
@ActiveProfiles("test")
class OrderRepositoryTest {

    @Autowired
    private OrderRepository orderRepository;

    @Test
    void shouldFindOrdersByCustomerAndStatus() {
        // ... insert test data and assert query results
    }
}
```
