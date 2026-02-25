# Gatling Performance Testing

## Setup

### build.gradle — Gatling Plugin

```groovy
plugins {
    id 'io.gatling.gradle' version '3.11.5.2'
}

gatling {
    // Simulation source set lives in gatling/src/gatling/java
}
```

Gatling simulations go in `src/gatling/java/` (Gradle plugin convention). Use the Java DSL, not Scala.

### Dependencies

The Gatling Gradle plugin auto-manages dependencies. If you need extras:

```groovy
gatlingImplementation 'com.fasterxml.jackson.core:jackson-databind'
```

## Simulation Structure

### Basic Load Test

```java
package simulations;

import io.gatling.javaapi.core.*;
import io.gatling.javaapi.http.*;

import static io.gatling.javaapi.core.CoreDsl.*;
import static io.gatling.javaapi.http.HttpDsl.*;

import java.time.Duration;

public class OrderApiLoadTest extends Simulation {

    // --- Protocol ---
    private final HttpProtocolBuilder httpProtocol = http
            .baseUrl(System.getProperty("gatling.baseUrl", "http://localhost:8080"))
            .acceptHeader("application/json")
            .contentTypeHeader("application/json")
            .shareConnections();

    // --- Feeders ---
    private final FeederBuilder<String> customerIdFeeder = csv("customer-ids.csv").circular();

    // --- Scenarios ---
    private final ScenarioBuilder browseAndOrder = scenario("Browse and Place Order")
            .feed(customerIdFeeder)
            .exec(
                    http("List Products")
                            .get("/api/v1/products")
                            .queryParam("page", "0")
                            .queryParam("size", "20")
                            .check(status().is(200))
                            .check(jsonPath("$.content[0].id").saveAs("productId"))
            )
            .pause(Duration.ofSeconds(1), Duration.ofSeconds(3))
            .exec(
                    http("Get Product Detail")
                            .get("/api/v1/products/#{productId}")
                            .check(status().is(200))
            )
            .pause(Duration.ofMillis(500))
            .exec(
                    http("Create Order")
                            .post("/api/v1/orders")
                            .body(StringBody("""
                                    {
                                        "customerId": "#{customerId}",
                                        "items": [
                                            { "productId": "#{productId}", "quantity": 1 }
                                        ]
                                    }
                                    """))
                            .check(status().is(201))
                            .check(jsonPath("$.id").saveAs("orderId"))
            )
            .exec(
                    http("Get Order Status")
                            .get("/api/v1/orders/#{orderId}")
                            .check(status().is(200))
            );

    // --- Load Profile ---
    {
        setUp(
                browseAndOrder.injectOpen(
                        // Warm up
                        rampUsers(10).during(Duration.ofSeconds(10)),
                        // Steady state
                        constantUsersPerSec(20).during(Duration.ofMinutes(5)),
                        // Spike
                        rampUsers(100).during(Duration.ofSeconds(30)),
                        // Cool down
                        nothingFor(Duration.ofSeconds(10))
                )
        ).protocols(httpProtocol)
                .assertions(
                        global().responseTime().percentile3().lt(500),   // p95 < 500ms
                        global().responseTime().percentile4().lt(1000),  // p99 < 1s
                        global().successfulRequests().percent().gt(99.0), // >99% success
                        global().requestsPerSec().gte(50.0)              // ≥50 rps
                );
    }
}
```

### Smoke Test (for CI/CD)

```java
public class SmokeSuite extends Simulation {

    private final HttpProtocolBuilder httpProtocol = http
            .baseUrl(System.getProperty("gatling.baseUrl", "http://localhost:8080"))
            .acceptHeader("application/json");

    private final ScenarioBuilder healthCheck = scenario("Smoke Test")
            .exec(
                    http("Health").get("/actuator/health").check(status().is(200)),
                    http("List Products").get("/api/v1/products").check(status().is(200))
            );

    {
        setUp(
                healthCheck.injectOpen(atOnceUsers(5))
        ).protocols(httpProtocol)
                .assertions(
                        global().failedRequests().count().is(0L)
                );
    }
}
```

### Stress Test

```java
public class StressTest extends Simulation {

    private final HttpProtocolBuilder httpProtocol = http
            .baseUrl(System.getProperty("gatling.baseUrl", "http://localhost:8080"))
            .acceptHeader("application/json");

    private final ScenarioBuilder highLoad = scenario("Stress Test")
            .exec(
                    http("Get Products")
                            .get("/api/v1/products")
                            .check(status().in(200, 429))  // accept rate-limited responses
            );

    {
        setUp(
                highLoad.injectOpen(
                        // Ramp until breaking point
                        incrementUsersPerSec(10)
                                .times(10)
                                .eachLevelLasting(Duration.ofSeconds(30))
                                .separatedByRampsLasting(Duration.ofSeconds(5))
                                .startingFrom(10)
                )
        ).protocols(httpProtocol);
        // No assertions — we're looking for the breaking point
    }
}
```

## Running

```bash
# Run specific simulation
./gradlew gatlingRun -Dgatling.simulationClass=simulations.OrderApiLoadTest

# Run against a specific environment
./gradlew gatlingRun -Dgatling.simulationClass=simulations.OrderApiLoadTest \
  -Dgatling.baseUrl=https://uat.service.example.com

# Run all simulations
./gradlew gatlingRun
```

Reports are generated in `build/reports/gatling/`.

## Feeder Files

Place CSV feeders in `src/gatling/resources/`:

```csv
customerId
550e8400-e29b-41d4-a716-446655440001
550e8400-e29b-41d4-a716-446655440002
550e8400-e29b-41d4-a716-446655440003
```

For dynamic data, use a custom feeder:

```java
Iterator<Map<String, Object>> customFeeder = Stream.generate(() ->
        Map.<String, Object>of(
                "customerId", UUID.randomUUID().toString(),
                "quantity", ThreadLocalRandom.current().nextInt(1, 10)
        )
).iterator();

// Usage: .feed(customFeeder)
```

## Best Practices

- **Think time**: Always add realistic `pause()` between requests. Real users don't hammer endpoints sequentially.
- **Assertions in CI**: Define p95/p99 latency and error-rate thresholds so CI fails when performance regresses.
- **Separate suites**: Smoke (CI gate, <30s), Load (steady-state validation, 5-10min), Stress (find limits, 15-30min), Soak (memory leaks, 1-4hr).
- **Data isolation**: Use dedicated test data per Gatling run so it doesn't collide with manual QA.
- **Connection sharing**: Use `.shareConnections()` on the protocol for realistic connection pooling.
