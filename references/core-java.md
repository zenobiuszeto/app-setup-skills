# Core Java 17/21 Patterns

## Virtual Threads (Java 21)

Virtual threads are lightweight threads managed by the JVM, ideal for I/O-bound workloads like database queries, HTTP calls, and message consumers. They let you write blocking code without the thread-pool sizing headaches of platform threads.

### Enabling in Spring Boot

```yaml
# application.yml
spring:
  threads:
    virtual:
      enabled: true  # Spring Boot 3.2+ — uses virtual threads for request handling
```

That single property switches Tomcat (or Jetty) to dispatch every request on a virtual thread. No code changes needed for existing `@RestController` and `@Service` classes.

### When to Use Virtual Threads

Use them when:
- **I/O-bound work**: DB calls, REST client calls, file I/O, Redis, Kafka producers — anywhere the thread waits.
- **High-concurrency handlers**: an endpoint that fans out to multiple downstream services.

Avoid them when:
- **CPU-bound work**: heavy computation, image processing, crypto — these don't benefit (they need real OS threads). Use a dedicated `ForkJoinPool` or parallel streams instead.
- **Synchronized blocks holding monitors**: virtual threads pinned to carrier threads during `synchronized` blocks. Prefer `ReentrantLock` if the critical section involves I/O.

### Manual Usage

```java
// Structured concurrency (Java 21 preview — incubator)
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Subtask<User> userTask = scope.fork(() -> userService.findById(userId));
    Subtask<List<Order>> ordersTask = scope.fork(() -> orderService.findByUser(userId));

    scope.join().throwIfFailed();

    return new UserDashboard(userTask.get(), ordersTask.get());
}

// Simple virtual thread executor
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<Result>> futures = tasks.stream()
            .map(task -> executor.submit(() -> process(task)))
            .toList();

    List<Result> results = futures.stream()
            .map(f -> {
                try { return f.get(); }
                catch (Exception e) { throw new RuntimeException(e); }
            })
            .toList();
}
```

### Async with Virtual Threads

Replace `@Async` + thread pool with virtual thread executor:

```java
@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean
    public Executor taskExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }
}
```

Now every `@Async` method runs on a virtual thread automatically.

---

## Records (Java 17+)

Use records for DTOs, value objects, and anything that's just data with no mutable state:

```java
// Request DTO
public record CreateOrderRequest(
    @NotNull UUID customerId,
    @NotEmpty List<OrderItemRequest> items
) {}

// Value object
public record Money(BigDecimal amount, Currency currency) {
    public Money {
        if (amount.compareTo(BigDecimal.ZERO) < 0) {
            throw new IllegalArgumentException("Amount cannot be negative");
        }
    }

    public Money add(Money other) {
        if (!this.currency.equals(other.currency)) {
            throw new IllegalArgumentException("Cannot add different currencies");
        }
        return new Money(this.amount.add(other.amount), this.currency);
    }
}

// Compound key
public record OrderItemId(UUID orderId, String productSku) {}
```

Records cannot be JPA `@Entity` classes (they're final and have no no-arg constructor). Use records for DTOs and value objects; use Lombok-annotated classes for entities.

---

## Sealed Classes (Java 17+)

Sealed classes are excellent for modeling domain states where you know all the variants upfront:

```java
public sealed interface PaymentResult
        permits PaymentResult.Success, PaymentResult.Declined, PaymentResult.Error {

    record Success(String transactionId, Instant processedAt) implements PaymentResult {}
    record Declined(String reason, String declineCode) implements PaymentResult {}
    record Error(String message, Exception cause) implements PaymentResult {}
}
```

Pattern matching with sealed types (Java 21):

```java
public String describe(PaymentResult result) {
    return switch (result) {
        case PaymentResult.Success s -> "Paid: " + s.transactionId();
        case PaymentResult.Declined d -> "Declined: " + d.reason();
        case PaymentResult.Error e -> "Error: " + e.message();
    };
    // No default needed — compiler knows all cases are covered
}
```

---

## Pattern Matching (Java 21)

### instanceof Pattern Matching

```java
// Before
if (obj instanceof String) {
    String s = (String) obj;
    return s.length();
}

// After
if (obj instanceof String s) {
    return s.length();
}
```

### Switch Pattern Matching

```java
public double calculateDiscount(Object customer) {
    return switch (customer) {
        case PremiumCustomer p when p.yearsActive() > 5 -> 0.20;
        case PremiumCustomer p -> 0.15;
        case RegularCustomer r -> 0.05;
        case null -> 0.0;
        default -> 0.0;
    };
}
```

---

## Text Blocks

For multi-line strings (SQL, JSON, templates):

```java
String query = """
        SELECT o.id, o.status, o.total
        FROM orders o
        WHERE o.customer_id = :customerId
          AND o.created_at >= :since
        ORDER BY o.created_at DESC
        """;
```

---

## Helpful API Additions

### Stream Improvements

```java
// toList() — unmodifiable list (Java 16+)
var names = users.stream().map(User::getName).toList();

// mapMulti (Java 16+) — flat-map alternative
var allItems = orders.stream()
        .<OrderItem>mapMulti((order, consumer) ->
                order.getItems().forEach(consumer))
        .toList();

// Gatherers (Java 22 preview — mention only if user is on bleeding edge)
```

### Optional Improvements

```java
// or() — chain fallback suppliers
Optional<User> user = localCache.find(id)
        .or(() -> remoteCache.find(id))
        .or(() -> database.find(id));

// ifPresentOrElse()
user.ifPresentOrElse(
        u -> log.info("Found user: {}", u.getName()),
        () -> log.warn("User not found for id={}", id)
);
```

### HttpClient (java.net.http)

For lightweight HTTP calls without Spring's `RestClient`:

```java
var client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .executor(Executors.newVirtualThreadPerTaskExecutor())
        .build();

var request = HttpRequest.newBuilder()
        .uri(URI.create("https://api.example.com/data"))
        .header("Authorization", "Bearer " + token)
        .GET()
        .build();

var response = client.send(request, HttpResponse.BodyHandlers.ofString());
```
