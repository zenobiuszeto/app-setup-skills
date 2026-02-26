# Regression Testing — Strategy, Suites, and Orchestration

Regression testing ensures that existing functionality is not broken by new changes. At enterprise scale, this means structured test suites with clear ownership, fast feedback loops, and automated gate enforcement.

## Regression Test Strategy

### Levels of Regression Coverage

| Level | Scope | Speed | When to Run |
|---|---|---|---|
| **Unit Regression** | Changed class + immediate collaborators | ~1 min | Every commit (CI) |
| **Service Regression** | Full service API contract | ~5-10 min | Every PR merge to `main` |
| **Integration Regression** | Cross-service flows | ~15-30 min | After deploy to UAT |
| **System Regression** | End-to-end critical paths | ~30-60 min | Before production release |
| **Performance Regression** | Latency/throughput SLA | ~10-30 min | Nightly or pre-release |

---

## Tagging and Suite Organisation

Tag tests to control which suite they belong to:

### JUnit 5 Tags

```java
@Tag("regression")
@Tag("order-management")
@SpringBootTest
class OrderRegressionTest {

    @Test
    @Tag("smoke")
    void shouldCreateOrder() { ... }

    @Test
    @Tag("slow")
    void shouldHandleConcurrentOrderCreation() { ... }

    @Test
    @Tag("critical-path")
    void shouldCompleteFullOrderLifecycle() { ... }
}
```

### Gradle Suite Configuration

```groovy
// build.gradle
tasks.register('regressionTest', Test) {
    description = 'Runs regression test suite.'
    group = 'verification'
    testClassesDirs = sourceSets.test.output.classesDirs
    classpath = sourceSets.test.runtimeClasspath
    useJUnitPlatform {
        includeTags 'regression'
        excludeTags 'slow'     // exclude slow tests from the fast regression gate
    }
    shouldRunAfter integrationTest
}

tasks.register('fullRegressionTest', Test) {
    description = 'Runs full regression suite including slow tests.'
    group = 'verification'
    testClassesDirs = sourceSets.test.output.classesDirs
    classpath = sourceSets.test.runtimeClasspath
    useJUnitPlatform {
        includeTags 'regression'
    }
}

tasks.register('criticalPathTest', Test) {
    description = 'Runs critical-path regression only (fastest possible gate).'
    group = 'verification'
    testClassesDirs = sourceSets.test.output.classesDirs
    classpath = sourceSets.test.runtimeClasspath
    useJUnitPlatform {
        includeTags 'critical-path'
    }
}
```

---

## Service Regression Suite

### API Contract Regression

Verify that every API endpoint returns the correct structure and behaviour after each change:

```java
@Tag("regression")
@Tag("api-contract")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
@Sql(scripts = "classpath:regression-seed.sql", executionPhase = Sql.ExecutionPhase.BEFORE_TEST_METHOD)
@Sql(scripts = "classpath:regression-cleanup.sql", executionPhase = Sql.ExecutionPhase.AFTER_TEST_METHOD)
class OrderApiRegressionTest {

    @LocalServerPort
    private int port;

    @BeforeEach
    void setUp() {
        RestAssured.port = port;
    }

    // --- List Orders ---

    @Test
    @Tag("critical-path")
    void listOrders_shouldReturn200AndPagedResponse() {
        given()
            .auth().oauth2(testToken("USER"))
            .queryParam("page", 0).queryParam("size", 10)
        .when()
            .get("/api/v1/orders")
        .then()
            .statusCode(200)
            .body("content", notNullValue())
            .body("page", equalTo(0))
            .body("size", equalTo(10));
    }

    @Test
    void listOrders_shouldRespectPaginationBoundaries() {
        // Seed 25 orders; page 2 of size 10 should return 5
        given()
            .auth().oauth2(testToken("USER"))
            .queryParam("page", 2).queryParam("size", 10)
        .when()
            .get("/api/v1/orders")
        .then()
            .statusCode(200)
            .body("content.size()", equalTo(5))
            .body("last", equalTo(true));
    }

    // --- Create Order ---

    @Test
    @Tag("critical-path")
    void createOrder_shouldReturn201WithLocation() {
        given()
            .auth().oauth2(testToken("USER"))
            .contentType(ContentType.JSON)
            .body(OrderTestFixtures.validCreateRequest())
        .when()
            .post("/api/v1/orders")
        .then()
            .statusCode(201)
            .header("Location", matchesPattern(".*/orders/[a-f0-9-]{36}"))
            .body("id", notNullValue())
            .body("status", equalTo("CREATED"));
    }

    @Test
    void createOrder_shouldReturn422ForInvalidPayload() {
        given()
            .auth().oauth2(testToken("USER"))
            .contentType(ContentType.JSON)
            .body("{\"items\": []}")   // empty items — invalid
        .when()
            .post("/api/v1/orders")
        .then()
            .statusCode(422)
            .body("code", equalTo("VALIDATION_ERROR"));
    }

    // --- Delete Order ---

    @Test
    void deleteOrder_shouldReturn403ForNonAdmin() {
        String existingOrderId = "00000000-0000-0000-0000-000000000001";
        given()
            .auth().oauth2(testToken("USER"))
        .when()
            .delete("/api/v1/orders/{id}", existingOrderId)
        .then()
            .statusCode(403);
    }

    @Test
    @Tag("critical-path")
    void deleteOrder_shouldReturn204ForAdmin() {
        String existingOrderId = "00000000-0000-0000-0000-000000000001";
        given()
            .auth().oauth2(testToken("ADMIN"))
        .when()
            .delete("/api/v1/orders/{id}", existingOrderId)
        .then()
            .statusCode(204);
    }
}
```

### Test Fixtures

Centralise test data to avoid duplication across regression tests:

```java
public class OrderTestFixtures {

    public static Map<String, Object> validCreateRequest() {
        return Map.of(
            "customerId", "550e8400-e29b-41d4-a716-446655440001",
            "items", List.of(
                Map.of("productId", "550e8400-e29b-41d4-a716-446655440099", "quantity", 2)
            )
        );
    }

    public static Order persistedOrder(UUID customerId) {
        return Order.builder()
                .customerId(customerId)
                .status(OrderStatus.CREATED)
                .total(BigDecimal.valueOf(19.98))
                .build();
    }
}
```

---

## Integration Regression — Cross-Service

Test that multiple services work together correctly after a deployment:

```java
@Tag("regression")
@Tag("integration")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
class OrderInventoryIntegrationRegressionTest {

    @Container
    static KafkaContainer kafka = new KafkaContainer(
            DockerImageName.parse("confluentinc/cp-kafka:7.6.0"));

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @Autowired
    private KafkaTemplate<String, Object> kafkaTemplate;

    @Autowired
    private InventoryRepository inventoryRepository;

    @Test
    void whenOrderIsCreated_inventoryShouldBeReserved() throws Exception {
        var event = OrderCreatedEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .orderId(UUID.randomUUID())
                .items(List.of(
                    new OrderItemSnapshot("PROD-01", 3, BigDecimal.valueOf(9.99))
                ))
                .build();

        kafkaTemplate.send("order-events", event.getOrderId().toString(), event).get();

        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            var reservation = inventoryRepository.findByOrderId(event.getOrderId());
            assertThat(reservation).isPresent();
            assertThat(reservation.get().getStatus()).isEqualTo(ReservationStatus.RESERVED);
        });
    }
}
```

---

## Gatling Regression Suite

Use Gatling to run a functional-correctness regression suite (not just performance) — it validates that all API contracts are intact under normal load:

```java
// gatling/src/gatling/java/simulations/RegressionSuite.java
public class RegressionSuite extends Simulation {

    private final HttpProtocolBuilder httpProtocol = http
            .baseUrl(System.getProperty("gatling.baseUrl", "http://localhost:8080"))
            .acceptHeader("application/json")
            .contentTypeHeader("application/json")
            .header("Authorization", "Bearer " + System.getProperty("gatling.token", ""));

    // --- Scenario: Full order lifecycle ---
    private final ScenarioBuilder orderLifecycle = scenario("Order Lifecycle Regression")
            .exec(
                http("Create Order")
                    .post("/api/v1/orders")
                    .body(StringBody(OrderPayloads.CREATE_ORDER))
                    .check(status().is(201))
                    .check(jsonPath("$.id").saveAs("orderId"))
                    .check(jsonPath("$.status").is("CREATED"))
            )
            .pause(Duration.ofMillis(200))
            .exec(
                http("Get Order")
                    .get("/api/v1/orders/#{orderId}")
                    .check(status().is(200))
                    .check(jsonPath("$.id").isEL("#{orderId}"))
            )
            .pause(Duration.ofMillis(200))
            .exec(
                http("List Orders")
                    .get("/api/v1/orders")
                    .queryParam("page", "0")
                    .queryParam("size", "10")
                    .check(status().is(200))
                    .check(jsonPath("$.content").exists())
            );

    // --- Scenario: Security regression ---
    private final ScenarioBuilder securityRegression = scenario("Security Regression")
            .exec(
                http("Unauthenticated request should fail")
                    .get("/api/v1/orders")
                    .header("Authorization", "")  // no token
                    .check(status().is(401))
            )
            .exec(
                http("Invalid token should fail")
                    .get("/api/v1/orders")
                    .header("Authorization", "Bearer invalid-token")
                    .check(status().is(401))
            );

    {
        setUp(
            orderLifecycle.injectOpen(atOnceUsers(5)),
            securityRegression.injectOpen(atOnceUsers(3))
        )
        .protocols(httpProtocol)
        .assertions(
            global().failedRequests().count().is(0L),      // zero failures
            global().responseTime().max().lt(3000)          // all responses under 3s
        );
    }
}
```

---

## Regression Test Data Management

### Database Seed Scripts

```sql
-- src/test/resources/regression-seed.sql
-- Stable UUIDs for deterministic regression tests

INSERT INTO customers (id, email, name, created_at)
VALUES ('550e8400-e29b-41d4-a716-446655440001', 'alice@example.com', 'Alice Smith', NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, sku, name, price, stock)
VALUES
    ('550e8400-e29b-41d4-a716-446655440099', 'PROD-01', 'Widget A', 9.99, 100),
    ('550e8400-e29b-41d4-a716-446655440100', 'PROD-02', 'Gadget B', 24.99, 50)
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders (id, customer_id, status, total, created_at)
VALUES
    ('00000000-0000-0000-0000-000000000001',
     '550e8400-e29b-41d4-a716-446655440001',
     'CREATED', 9.99, NOW())
ON CONFLICT (id) DO NOTHING;
```

```sql
-- src/test/resources/regression-cleanup.sql
DELETE FROM order_items WHERE order_id NOT IN ('00000000-0000-0000-0000-000000000001');
DELETE FROM orders WHERE id NOT IN ('00000000-0000-0000-0000-000000000001');
```

---

## CI/CD Regression Gate

```yaml
# In .github/workflows/ci.yml — regression stage
  regression-test:
    needs: build-and-test
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: regressiondb
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U test"
          --health-interval 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: temurin
          cache: gradle

      - name: Run regression tests
        run: ./gradlew regressionTest
        env:
          SPRING_DATASOURCE_URL: jdbc:postgresql://localhost:5432/regressiondb
          SPRING_DATASOURCE_USERNAME: test
          SPRING_DATASOURCE_PASSWORD: test
          SPRING_PROFILES_ACTIVE: test

      - name: Publish regression test results
        if: always()
        uses: mikepenz/action-junit-report@v4
        with:
          report_paths: '**/build/test-results/regressionTest/**/TEST-*.xml'
          check_name: Regression Test Results
```

---

## Regression Failure Triage

When a regression fails in CI:

1. **Check if it's a real regression** — compare against the last green build on `main`.
2. **Identify the breaking commit** — use `git bisect` if not obvious.
3. **Classify the failure**:
   - *Expected* — intentional behaviour change, update the test.
   - *Regression* — unintended breakage, fix the code.
   - *Flaky* — environment/timing issue, quarantine with `@Disabled("flaky: JIRA-1234")` and track.

### Flaky Test Quarantine

```java
@Test
@Tag("flaky")
@Disabled("Flaky due to timing — tracked in JIRA-1234")
void shouldProcessEventWithinTimeout() { ... }
```

Track flaky tests in a dedicated dashboard (e.g., Allure, Serenity, or a simple spreadsheet). Never leave flaky tests in the main suite — they erode confidence in CI.

---

## Allure Reporting

```groovy
// build.gradle
plugins {
    id 'io.qameta.allure' version '2.12.0'
}

allure {
    adapter {
        autoconfigure = true
        aspectjWeaver = true
    }
}

dependencies {
    testImplementation 'io.qameta.allure:allure-junit5:2.27.0'
    testImplementation 'io.qameta.allure:allure-rest-assured:2.27.0'
}
```

```java
@Epic("Order Management")
@Feature("Order Creation")
@Story("Customer places a valid order")
@Severity(SeverityLevel.CRITICAL)
@Test
void shouldCreateOrder() {
    Allure.step("Prepare order request", () -> { /* ... */ });
    Allure.step("Submit order to API", () -> { /* ... */ });
    Allure.step("Verify order created", () -> { /* ... */ });
}
```

```bash
# Generate and open Allure report
./gradlew allureReport
./gradlew allureServe   # opens browser
```
