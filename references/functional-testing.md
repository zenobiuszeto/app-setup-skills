# Functional Testing — BDD with Cucumber, REST Assured, and Contract Testing

Functional tests verify that the application behaves correctly from the outside — they test features as described in business requirements, not internal implementation details. They run against a fully assembled application (or a deployed environment).

## Test Pyramid for Enterprise Services

```
              /\
             /  \   Manual Exploratory
            /----\
           /  E2E  \  (few — slow, expensive)
          /----------\
         / Functional  \ (moderate — BDD/API-level)
        /----------------\
       / Integration Tests \ (many — Testcontainers)
      /--------------------\
     /    Unit Tests        \ (most — fast, isolated)
    /________________________\
```

- **Unit tests** — fast, isolated, no Spring context (see SKILL.md conventions).
- **Integration tests** — `@SpringBootTest` with Testcontainers.
- **Functional tests** — BDD scenarios or REST-Assured suites against a running app.
- **E2E tests** — full system flows covering multiple services.

---

## BDD with Cucumber

Cucumber lets business stakeholders write acceptance criteria in Gherkin, which developers then automate.

### Dependency Setup

```groovy
// build.gradle
configurations {
    functionalTestImplementation.extendsFrom testImplementation
}

sourceSets {
    functionalTest {
        java.srcDir 'src/functionalTest/java'
        resources.srcDir 'src/functionalTest/resources'
        compileClasspath += sourceSets.main.output
        runtimeClasspath += sourceSets.main.output
    }
}

dependencies {
    functionalTestImplementation 'io.cucumber:cucumber-java:7.18.1'
    functionalTestImplementation 'io.cucumber:cucumber-spring:7.18.1'
    functionalTestImplementation 'io.cucumber:cucumber-junit-platform-engine:7.18.1'
    functionalTestImplementation 'io.rest-assured:rest-assured:5.4.0'
    functionalTestImplementation 'io.rest-assured:json-path:5.4.0'
    functionalTestImplementation 'io.rest-assured:spring-mock-mvc:5.4.0'  // optional
    functionalTestImplementation 'org.springframework.boot:spring-boot-starter-test'
}

tasks.register('functionalTest', Test) {
    description = 'Runs functional (BDD) tests.'
    group = 'verification'
    testClassesDirs = sourceSets.functionalTest.output.classesDirs
    classpath = sourceSets.functionalTest.runtimeClasspath
    useJUnitPlatform()
    systemProperty 'cucumber.publish.quiet', 'true'
    shouldRunAfter integrationTest
}
```

### Feature File (Gherkin)

```gherkin
# src/functionalTest/resources/features/order-management.feature
Feature: Order Management
  As a customer
  I want to be able to place and manage orders
  So that I can purchase products

  Background:
    Given the following products exist:
      | sku     | name          | price |
      | PROD-01 | Widget A      | 9.99  |
      | PROD-02 | Gadget B      | 24.99 |

  Scenario: Customer successfully places an order
    Given I am authenticated as customer "alice@example.com"
    When I place an order for:
      | sku     | quantity |
      | PROD-01 | 2        |
      | PROD-02 | 1        |
    Then the order should be created with status "CREATED"
    And the order total should be "44.97"
    And I should receive an order confirmation event

  Scenario: Order placement fails for out-of-stock item
    Given product "PROD-01" has 0 units in stock
    And I am authenticated as customer "alice@example.com"
    When I place an order for:
      | sku     | quantity |
      | PROD-01 | 1        |
    Then the order should fail with status 422
    And the response should contain "Insufficient stock"

  Scenario Outline: Order status transitions
    Given I have an order in status "<initial>"
    When the order is "<action>"
    Then the order status should be "<final>"
    Examples:
      | initial   | action    | final      |
      | CREATED   | confirmed | CONFIRMED  |
      | CONFIRMED | shipped   | SHIPPED    |
      | SHIPPED   | delivered | DELIVERED  |
```

### Step Definitions

```java
// src/functionalTest/java/steps/OrderSteps.java
@CucumberContextConfiguration
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public class CucumberSpringConfig {}
```

```java
@Slf4j
@RequiredArgsConstructor
public class OrderSteps {

    @LocalServerPort
    private int port;

    private RequestSpecification requestSpec;
    private Response lastResponse;

    @Before
    public void setup() {
        RestAssured.port = port;
        requestSpec = given()
                .contentType(ContentType.JSON)
                .accept(ContentType.JSON);
    }

    @Given("I am authenticated as customer {string}")
    public void iAmAuthenticatedAsCustomer(String email) {
        String token = obtainJwt(email);
        requestSpec = requestSpec.header("Authorization", "Bearer " + token);
    }

    @When("I place an order for:")
    public void iPlaceAnOrderFor(DataTable dataTable) {
        var items = dataTable.asMaps().stream()
                .map(row -> Map.of(
                        "sku", row.get("sku"),
                        "quantity", Integer.parseInt(row.get("quantity"))))
                .toList();

        lastResponse = requestSpec
                .body(Map.of("items", items))
                .post("/api/v1/orders");
    }

    @Then("the order should be created with status {string}")
    public void theOrderShouldBeCreatedWithStatus(String expectedStatus) {
        lastResponse.then()
                .statusCode(201)
                .body("status", equalTo(expectedStatus));
    }

    @Then("the order total should be {string}")
    public void theOrderTotalShouldBe(String expectedTotal) {
        lastResponse.then()
                .body("total", equalTo(new BigDecimal(expectedTotal)));
    }

    @Then("the order should fail with status {int}")
    public void theOrderShouldFailWithStatus(int statusCode) {
        lastResponse.then().statusCode(statusCode);
    }

    @Then("the response should contain {string}")
    public void theResponseShouldContain(String text) {
        lastResponse.then().body(containsString(text));
    }
}
```

### Cucumber JUnit Platform Configuration

```java
// src/functionalTest/java/runner/CucumberTestRunner.java
@Suite
@IncludeEngines("cucumber")
@ConfigurationParameter(key = GLUE_PROPERTY_NAME,
        value = "steps,config")
@ConfigurationParameter(key = FEATURES_PROPERTY_NAME,
        value = "src/functionalTest/resources/features")
@ConfigurationParameter(key = PLUGIN_PROPERTY_NAME,
        value = "pretty, html:build/reports/cucumber/report.html, " +
                "json:build/reports/cucumber/report.json")
@ConfigurationParameter(key = FILTER_TAGS_PROPERTY_NAME,
        value = "not @Disabled")
public class CucumberTestRunner {}
```

### Tagging Scenarios

Tag scenarios to allow selective execution:

```gherkin
@smoke @order
Scenario: Customer successfully places an order
  ...

@regression @order @slow
Scenario: Full order lifecycle from placement to delivery
  ...

@security
Scenario: Unauthenticated user cannot place order
  ...
```

```bash
# Run only smoke tests
./gradlew functionalTest -Dcucumber.filter.tags="@smoke"

# Run all except slow
./gradlew functionalTest -Dcucumber.filter.tags="not @slow"

# Run security scenarios
./gradlew functionalTest -Dcucumber.filter.tags="@security"
```

---

## REST Assured API Tests

For API-level functional tests without the BDD layer — faster to write and maintain for pure API validation.

### Test Setup

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
class OrderApiTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @Container
    static GenericContainer<?> redis = new GenericContainer<>("redis:7-alpine")
            .withExposedPorts(6379);

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.data.redis.host", redis::getHost);
        registry.add("spring.data.redis.port", () -> redis.getMappedPort(6379));
    }

    @LocalServerPort
    private int port;

    @BeforeEach
    void setUp() {
        RestAssured.port = port;
        RestAssured.basePath = "/api/v1";
    }

    @Test
    void shouldCreateOrder() {
        var requestBody = """
            {
                "customerId": "550e8400-e29b-41d4-a716-446655440001",
                "items": [
                    { "productId": "550e8400-e29b-41d4-a716-446655440099", "quantity": 2 }
                ]
            }
            """;

        given()
            .auth().oauth2(getTestToken("USER"))
            .contentType(ContentType.JSON)
            .body(requestBody)
        .when()
            .post("/orders")
        .then()
            .statusCode(201)
            .header("Location", matchesPattern(".*/orders/[a-f0-9-]+"))
            .body("status", equalTo("CREATED"))
            .body("id", notNullValue())
            .body("total", greaterThan(0f));
    }

    @Test
    void shouldReturnPaginatedOrders() {
        given()
            .auth().oauth2(getTestToken("USER"))
            .queryParam("page", 0)
            .queryParam("size", 10)
        .when()
            .get("/orders")
        .then()
            .statusCode(200)
            .body("content", notNullValue())
            .body("page", equalTo(0))
            .body("size", equalTo(10))
            .body("totalElements", greaterThanOrEqualTo(0));
    }

    @Test
    void shouldReturn401ForUnauthenticatedRequest() {
        given()
            .contentType(ContentType.JSON)
        .when()
            .get("/orders")
        .then()
            .statusCode(401);
    }

    @Test
    void shouldReturn403WhenUserTriesToDelete() {
        given()
            .auth().oauth2(getTestToken("USER"))
        .when()
            .delete("/orders/{id}", UUID.randomUUID())
        .then()
            .statusCode(403);
    }
}
```

---

## Contract Testing with Pact

Contract tests prevent integration failures between services. The consumer defines what it expects; the provider verifies it can satisfy those expectations.

### Consumer Side

```groovy
// Consumer service build.gradle
testImplementation 'au.com.dius.pact.consumer:junit5:4.6.14'
```

```java
@ExtendWith(PactConsumerTestExt.class)
@PactTestFor(providerName = "order-service", pactVersion = PactSpecVersion.V4)
class OrderServiceClientPactTest {

    @Pact(consumer = "inventory-service")
    public V4Pact getOrderPact(PactDslWithProvider builder) {
        return builder
                .given("order 123 exists")
                .uponReceiving("a request for order 123")
                    .path("/api/v1/orders/00000000-0000-0000-0000-000000000123")
                    .method("GET")
                    .headers(Map.of("Authorization", "Bearer test-token"))
                .willRespondWith()
                    .status(200)
                    .headers(Map.of("Content-Type", "application/json"))
                    .body(LambdaDsl.newJsonBody(body -> {
                        body.uuid("id", UUID.fromString("00000000-0000-0000-0000-000000000123"));
                        body.stringType("status", "CREATED");
                        body.decimalType("total", 49.99);
                    }).build())
                .toPact(V4Pact.class);
    }

    @Test
    @PactTestFor(pactMethod = "getOrderPact")
    void shouldFetchOrderFromOrderService(MockServer mockServer) {
        RestAssured.baseURI = mockServer.getUrl();

        OrderResponse order = orderServiceClient.getOrder(
                UUID.fromString("00000000-0000-0000-0000-000000000123"));

        assertThat(order.id()).isNotNull();
        assertThat(order.status()).isEqualTo("CREATED");
    }
}
```

### Provider Verification

```groovy
// Provider service build.gradle
testImplementation 'au.com.dius.pact.provider:junit5spring:4.6.14'
```

```java
@Provider("order-service")
@PactBroker(url = "${PACT_BROKER_URL}", authentication = @PactBrokerAuth(token = "${PACT_BROKER_TOKEN}"))
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class OrderServicePactVerificationTest {

    @LocalServerPort
    private int port;

    @BeforeEach
    void setupTarget(PactVerificationContext context) {
        context.setTarget(new HttpTestTarget("localhost", port));
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void pactVerificationTestTemplate(PactVerificationContext context) {
        context.verifyInteraction();
    }

    @State("order 123 exists")
    void orderExists() {
        // Set up test data — insert order 123 into the database
    }
}
```

---

## Test Environments for Functional Tests

### Environment Configuration

```yaml
# src/functionalTest/resources/application-functional.yml
spring:
  datasource:
    url: ${TEST_DB_URL:jdbc:postgresql://localhost:5432/functest}
  kafka:
    bootstrap-servers: ${TEST_KAFKA:localhost:9092}

test:
  base-url: ${TEST_BASE_URL:http://localhost:8080}
  auth:
    client-id: ${TEST_CLIENT_ID:test-client}
    client-secret: ${TEST_CLIENT_SECRET:test-secret}
    token-url: ${TEST_TOKEN_URL:http://localhost:8180/realms/test/protocol/openid-connect/token}
```

### Test Data Management

```java
@Component
@Profile("functional")
public class TestDataManager {

    @Autowired
    private OrderRepository orderRepository;

    @Autowired
    private ProductRepository productRepository;

    @BeforeEach
    public void resetData() {
        orderRepository.deleteAll();
        productRepository.deleteAll();
        productRepository.saveAll(TestData.defaultProducts());
    }
}
```

Keep functional test data isolated:
- Use a dedicated database schema per test run (e.g., `functest_{runId}`).
- Reset with `@Sql(scripts = "classpath:functional-test-cleanup.sql", executionPhase = BEFORE_TEST_METHOD)`.
- Never run functional tests against production data.

---

## Reporting

### Serenity BDD (Enhanced Cucumber Reports)

```groovy
// build.gradle
plugins {
    id 'net.serenity-bdd.serenity-gradle-plugin' version '4.2.1'
}

dependencies {
    functionalTestImplementation 'net.serenity-bdd:serenity-core:4.2.1'
    functionalTestImplementation 'net.serenity-bdd:serenity-cucumber:4.2.1'
    functionalTestImplementation 'net.serenity-bdd:serenity-spring:4.2.1'
}
```

Serenity generates rich HTML reports showing which requirements pass/fail, screenshots (for UI tests), and living documentation.

### Publish to GitHub Pages

```yaml
# .github/workflows/functional-tests.yml
- name: Upload Serenity Report
  uses: actions/upload-pages-artifact@v3
  with:
    path: build/site/serenity

- name: Deploy to GitHub Pages
  uses: actions/deploy-pages@v4
```
