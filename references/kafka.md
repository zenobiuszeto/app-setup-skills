# Kafka Messaging

## Configuration

### KafkaConfig.java

```java
@Configuration
public class KafkaConfig {

    // --- Producer ---
    @Bean
    public ProducerFactory<String, Object> producerFactory(KafkaProperties kafkaProperties) {
        Map<String, Object> props = kafkaProperties.buildProducerProperties(null);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.RETRIES_CONFIG, 3);
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        return new DefaultKafkaProducerFactory<>(props);
    }

    @Bean
    public KafkaTemplate<String, Object> kafkaTemplate(
            ProducerFactory<String, Object> producerFactory) {
        return new KafkaTemplate<>(producerFactory);
    }

    // --- Consumer ---
    @Bean
    public ConsumerFactory<String, Object> consumerFactory(KafkaProperties kafkaProperties) {
        Map<String, Object> props = kafkaProperties.buildConsumerProperties(null);
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, JsonDeserializer.class);
        props.put(JsonDeserializer.TRUSTED_PACKAGES, "com.{org}.{service}.model.event");
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        return new DefaultKafkaConsumerFactory<>(props);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, Object> kafkaListenerContainerFactory(
            ConsumerFactory<String, Object> consumerFactory) {
        var factory = new ConcurrentKafkaListenerContainerFactory<String, Object>();
        factory.setConsumerFactory(consumerFactory);
        factory.setConcurrency(3);  // match partition count
        factory.getContainerProperties().setAckMode(ContainerProperties.AckMode.RECORD);
        factory.setCommonErrorHandler(new DefaultErrorHandler(
                new DeadLetterPublishingRecoverer(kafkaTemplate(null)),
                new FixedBackOff(1000L, 3L)  // 3 retries with 1s delay
        ));
        return factory;
    }
}
```

### application.yml

```yaml
spring:
  kafka:
    bootstrap-servers: ${KAFKA_BOOTSTRAP_SERVERS:localhost:9092}
    producer:
      acks: all
      retries: 3
      properties:
        enable.idempotence: true
        max.in.flight.requests.per.connection: 5
    consumer:
      group-id: ${spring.application.name}
      auto-offset-reset: earliest
      properties:
        spring.json.trusted.packages: "com.{org}.{service}.model.event"
    listener:
      concurrency: 3
```

## Event Model

Design events as immutable value objects with all the context a consumer needs:

```java
@Value
@Builder
public class OrderCreatedEvent {
    String eventId;          // UUID — for idempotency
    String eventType;        // "order.created"
    Instant timestamp;
    UUID orderId;
    UUID customerId;
    BigDecimal total;
    List<OrderItemSnapshot> items;

    @Value
    @Builder
    public static class OrderItemSnapshot {
        String productId;
        int quantity;
        BigDecimal unitPrice;
    }
}
```

Rules for event design:
- Always include an `eventId` (UUID) so consumers can deduplicate.
- Include a `timestamp` so consumers know when the event occurred.
- Carry enough data that consumers don't need to call back to the producer service. This avoids temporal coupling.
- Use past-tense verb names: `OrderCreatedEvent`, `PaymentProcessedEvent`, `InventoryReservedEvent`.

## Producer

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderEventPublisher {

    private static final String TOPIC = "order-events";
    private final KafkaTemplate<String, Object> kafkaTemplate;

    public void publishOrderCreated(Order order) {
        var event = OrderCreatedEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .eventType("order.created")
                .timestamp(Instant.now())
                .orderId(order.getId())
                .customerId(order.getCustomerId())
                .total(order.getTotal())
                .items(order.getItems().stream()
                        .map(this::toSnapshot)
                        .toList())
                .build();

        kafkaTemplate.send(TOPIC, order.getId().toString(), event)
                .whenComplete((result, ex) -> {
                    if (ex != null) {
                        log.error("Failed to publish order.created orderId={}", order.getId(), ex);
                    } else {
                        log.info("Published order.created orderId={} partition={} offset={}",
                                order.getId(),
                                result.getRecordMetadata().partition(),
                                result.getRecordMetadata().offset());
                    }
                });
    }
}
```

Use the entity's natural key (e.g., `orderId`) as the Kafka message key so all events for the same entity land on the same partition, preserving order.

## Consumer

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderEventConsumer {

    private final InventoryService inventoryService;
    private final IdempotencyStore idempotencyStore;

    @KafkaListener(
            topics = "order-events",
            groupId = "inventory-service",
            containerFactory = "kafkaListenerContainerFactory")
    public void handleOrderEvent(
            @Payload OrderCreatedEvent event,
            @Header(KafkaHeaders.RECEIVED_KEY) String key,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
            @Header(KafkaHeaders.OFFSET) long offset,
            Acknowledgment ack) {

        log.info("Received {} eventId={} orderId={} partition={} offset={}",
                event.getEventType(), event.getEventId(), event.getOrderId(),
                partition, offset);

        // Idempotency check — skip if already processed
        if (idempotencyStore.isDuplicate(event.getEventId())) {
            log.warn("Duplicate event skipped eventId={}", event.getEventId());
            ack.acknowledge();
            return;
        }

        try {
            inventoryService.reserveStock(event.getOrderId(), event.getItems());
            idempotencyStore.markProcessed(event.getEventId());
            ack.acknowledge();
        } catch (InsufficientStockException e) {
            log.warn("Insufficient stock for orderId={}", event.getOrderId());
            // Don't retry — publish a compensation event instead
            ack.acknowledge();
        }
    }
}
```

### Consumer Best Practices

- **Idempotency**: Consumers must handle duplicate delivery. Use the `eventId` to deduplicate (store processed IDs in Redis or a DB table with TTL).
- **Error handling**: Use `DefaultErrorHandler` with `DeadLetterPublishingRecoverer` for retries + DLQ. After N retries, the message goes to `{topic}.DLT`.
- **Concurrency**: Set listener concurrency equal to the number of topic partitions for maximum parallelism.
- **Manual acks**: Use `AckMode.RECORD` with `Acknowledgment` parameter for fine-grained control.
- **Backpressure**: If processing is slow, consider using `@KafkaListener` with a `BatchMessageListener` to consume in batches.

## Topic Management

Create topics declaratively via configuration:

```java
@Configuration
public class KafkaTopicConfig {

    @Bean
    public NewTopic orderEventsTopic() {
        return TopicBuilder.name("order-events")
                .partitions(6)
                .replicas(3)
                .config(TopicConfig.RETENTION_MS_CONFIG, String.valueOf(Duration.ofDays(7).toMillis()))
                .build();
    }

    @Bean
    public NewTopic orderEventsDltTopic() {
        return TopicBuilder.name("order-events.DLT")
                .partitions(1)
                .replicas(3)
                .build();
    }
}
```

## Testing with Testcontainers

```java
@SpringBootTest
@Testcontainers
class OrderEventConsumerIntegrationTest {

    @Container
    static KafkaContainer kafka = new KafkaContainer(
            DockerImageName.parse("confluentinc/cp-kafka:7.6.0"));

    @DynamicPropertySource
    static void kafkaProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.kafka.bootstrap-servers", kafka::getBootstrapServers);
    }

    @Autowired
    private KafkaTemplate<String, Object> kafkaTemplate;

    @Test
    void shouldProcessOrderCreatedEvent() throws Exception {
        var event = OrderCreatedEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .eventType("order.created")
                .orderId(UUID.randomUUID())
                // ...
                .build();

        kafkaTemplate.send("order-events", event.getOrderId().toString(), event).get();

        // Assert side effects (inventory reserved, DB updated, etc.)
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            // verify expected state
        });
    }
}
```
