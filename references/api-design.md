# API Design — REST, gRPC, and RPC

## REST API Patterns

### Controller Structure

Every REST controller follows this skeleton:

```java
@RestController
@RequestMapping("/api/v1/{resource}")
@RequiredArgsConstructor
@Slf4j
@Validated
@Tag(name = "{Resource}", description = "Operations on {resource}")
public class {Resource}Controller {

    private final {Resource}Service service;

    @GetMapping
    public ResponseEntity<PagedResponse<{Resource}Response>> list(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return ResponseEntity.ok(service.findAll(page, size));
    }

    @GetMapping("/{id}")
    public ResponseEntity<{Resource}Response> getById(@PathVariable UUID id) {
        return ResponseEntity.ok(service.findById(id));
    }

    @PostMapping
    public ResponseEntity<{Resource}Response> create(
            @Valid @RequestBody {Resource}Request request) {
        var created = service.create(request);
        URI location = URI.create("/api/v1/{resource}/" + created.getId());
        return ResponseEntity.created(location).body(created);
    }

    @PutMapping("/{id}")
    public ResponseEntity<{Resource}Response> update(
            @PathVariable UUID id,
            @Valid @RequestBody {Resource}Request request) {
        return ResponseEntity.ok(service.update(id, request));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        service.delete(id);
    }
}
```

### URL and Versioning Conventions

- Prefix all endpoints with `/api/v{N}/`.
- Use plural nouns for resource paths: `/api/v1/orders`, not `/api/v1/order`.
- Sub-resources: `/api/v1/orders/{orderId}/items`.
- Actions that don't map to CRUD: use a verb sub-path — `POST /api/v1/orders/{id}/cancel`.
- Use URI path versioning (simple, explicit) unless the user requests header-based versioning.

### Request / Response DTOs

Use Java records for simple DTOs (Java 17+):

```java
public record CreateOrderRequest(
    @NotNull UUID customerId,
    @NotEmpty List<OrderItemRequest> items,
    @Size(max = 500) String notes
) {}

public record OrderResponse(
    UUID id,
    UUID customerId,
    List<OrderItemResponse> items,
    OrderStatus status,
    BigDecimal total,
    Instant createdAt
) {}
```

For DTOs that need builder flexibility (e.g., optional fields, test factories), use Lombok:

```java
@Value
@Builder
public class OrderResponse {
    UUID id;
    UUID customerId;
    List<OrderItemResponse> items;
    OrderStatus status;
    BigDecimal total;
    Instant createdAt;
}
```

### Pagination Envelope

```java
@Value
@Builder
public class PagedResponse<T> {
    List<T> content;
    int page;
    int size;
    long totalElements;
    int totalPages;
    boolean last;

    public static <T> PagedResponse<T> from(Page<T> springPage) {
        return PagedResponse.<T>builder()
                .content(springPage.getContent())
                .page(springPage.getNumber())
                .size(springPage.getSize())
                .totalElements(springPage.getTotalElements())
                .totalPages(springPage.getTotalPages())
                .last(springPage.isLast())
                .build();
    }
}
```

### Content Negotiation and HATEOAS

Only add HATEOAS if the user explicitly requests it. By default, return plain JSON with pagination metadata — it's simpler and most client teams prefer it.

---

## gRPC API Patterns

### Proto File Conventions

```protobuf
syntax = "proto3";

package com.{org}.{service}.grpc;

option java_multiple_files = true;
option java_package = "com.{org}.{service}.grpc";
option java_outer_classname = "{Service}Proto";

import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";

service {Resource}Service {
    rpc Get{Resource} ({Resource}Request) returns ({Resource}Response);
    rpc List{Resource}s (List{Resource}sRequest) returns (List{Resource}sResponse);
    rpc Create{Resource} (Create{Resource}Request) returns ({Resource}Response);
    rpc Update{Resource} (Update{Resource}Request) returns ({Resource}Response);
    rpc Delete{Resource} ({Resource}Request) returns (google.protobuf.Empty);
    // Streaming example:
    rpc Stream{Resource}Updates (google.protobuf.Empty) returns (stream {Resource}Event);
}

message {Resource}Request {
    string id = 1;
}

message {Resource}Response {
    string id = 1;
    string name = 2;
    google.protobuf.Timestamp created_at = 3;
}
```

Place `.proto` files in `src/main/proto/`.

### gRPC Service Implementation

```java
@GrpcService
@Slf4j
@RequiredArgsConstructor
public class {Resource}GrpcService extends {Resource}ServiceGrpc.{Resource}ServiceImplBase {

    private final {Resource}Service service;

    @Override
    public void get{Resource}({Resource}Request request,
                              StreamObserver<{Resource}Response> responseObserver) {
        try {
            var entity = service.findById(UUID.fromString(request.getId()));
            responseObserver.onNext(toProto(entity));
            responseObserver.onCompleted();
        } catch (ResourceNotFoundException e) {
            responseObserver.onError(
                Status.NOT_FOUND
                    .withDescription(e.getMessage())
                    .asRuntimeException());
        }
    }

    @Override
    public void stream{Resource}Updates(Empty request,
                                        StreamObserver<{Resource}Event> responseObserver) {
        // Server-streaming: push events as they occur
        // Integrate with Kafka consumer or an ApplicationEventPublisher
    }
}
```

### gRPC Error Mapping

Map domain exceptions to gRPC status codes consistently:

| Domain Exception | gRPC Status |
|---|---|
| ResourceNotFoundException | NOT_FOUND |
| IllegalArgumentException | INVALID_ARGUMENT |
| AccessDeniedException | PERMISSION_DENIED |
| ConflictException | ALREADY_EXISTS |
| Unhandled / generic | INTERNAL |

Use a `GrpcExceptionAdvice` interceptor for centralized error mapping:

```java
@GrpcAdvice
public class GrpcExceptionAdvice {

    @GrpcExceptionHandler(ResourceNotFoundException.class)
    public StatusRuntimeException handleNotFound(ResourceNotFoundException e) {
        return Status.NOT_FOUND
                .withDescription(e.getMessage())
                .asRuntimeException();
    }
}
```

### gRPC Configuration

```yaml
# application.yml
grpc:
  server:
    port: 9090
    security:
      enabled: false  # enable TLS in prod
  client:
    # For calling other gRPC services
    {other-service}:
      address: static://{host}:{port}
      negotiationType: PLAINTEXT  # TLS in prod
```

---

## Internal RPC Patterns (REST-based)

For internal service-to-service calls that don't warrant gRPC complexity, use Spring's `RestClient` (Spring Boot 3.2+):

```java
@Configuration
public class OrderServiceClientConfig {

    @Bean
    public RestClient orderServiceClient(RestClient.Builder builder) {
        return builder
                .baseUrl("http://order-service:8080/api/v1")
                .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .requestInterceptor(new TraceContextPropagatingInterceptor())
                .build();
    }
}
```

```java
@Service
@RequiredArgsConstructor
public class OrderServiceClient {

    private final RestClient orderServiceClient;

    public OrderResponse getOrder(UUID orderId) {
        return orderServiceClient.get()
                .uri("/orders/{id}", orderId)
                .retrieve()
                .body(OrderResponse.class);
    }
}
```

Use `RestClient` over the older `RestTemplate` — it has a fluent API and integrates cleanly with OpenTelemetry for trace propagation.

For retries and circuit-breaking on internal calls, add Resilience4j:

```java
@Retry(name = "orderService", fallbackMethod = "getOrderFallback")
@CircuitBreaker(name = "orderService")
public OrderResponse getOrder(UUID orderId) { ... }
```
