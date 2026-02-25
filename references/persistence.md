# Persistence — JPA (PostgreSQL), MongoDB, and Redis Caching

## JPA with PostgreSQL

### Entity Design

```java
@Entity
@Table(name = "orders")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @EqualsAndHashCode.Include
    private UUID id;

    @Column(nullable = false)
    private UUID customerId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private OrderStatus status;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal total;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    @Builder.Default
    private List<OrderItem> items = new ArrayList<>();

    @Column(nullable = false, updatable = false)
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

    // Domain method — keep business logic on the entity when it's entity-scoped
    public void addItem(OrderItem item) {
        items.add(item);
        item.setOrder(this);
        recalculateTotal();
    }

    private void recalculateTotal() {
        this.total = items.stream()
                .map(i -> i.getPrice().multiply(BigDecimal.valueOf(i.getQuantity())))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
    }
}
```

Key points:
- `@EqualsAndHashCode(onlyExplicitlyIncluded = true)` with only `@Id` — avoids Hibernate proxy issues that `@Data` causes.
- Use `GenerationType.UUID` (JPA 3.1+) for distributed-friendly IDs.
- `@Builder.Default` for collection fields so Lombok's builder doesn't set them to null.
- Audit timestamps via `@PrePersist` / `@PreUpdate` (or use Spring Data's `@EnableJpaAuditing` with `@CreatedDate` / `@LastModifiedDate`).

### Repository

```java
public interface OrderRepository extends JpaRepository<Order, UUID> {

    List<Order> findByCustomerIdAndStatus(UUID customerId, OrderStatus status);

    @Query("SELECT o FROM Order o JOIN FETCH o.items WHERE o.id = :id")
    Optional<Order> findByIdWithItems(@Param("id") UUID id);

    @Query("SELECT o FROM Order o WHERE o.createdAt >= :since AND o.status = :status")
    Page<Order> findRecentByStatus(@Param("since") Instant since,
                                   @Param("status") OrderStatus status,
                                   Pageable pageable);

    @Modifying
    @Query("UPDATE Order o SET o.status = :status WHERE o.id = :id")
    int updateStatus(@Param("id") UUID id, @Param("status") OrderStatus status);
}
```

- Use `JOIN FETCH` to avoid N+1 queries on associations.
- Return `Page<T>` for paginated queries.
- Bulk updates via `@Modifying` + `@Query` when you don't need entity lifecycle hooks.

### Flyway Migrations

Place SQL files in `src/main/resources/db/migration/`:

```sql
-- V1__create_orders_table.sql
CREATE TABLE orders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID         NOT NULL,
    status      VARCHAR(20)  NOT NULL DEFAULT 'CREATED',
    total       NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer_status ON orders (customer_id, status);
CREATE INDEX idx_orders_created_at ON orders (created_at);
```

Naming convention: `V{version}__{description}.sql`. Always include indexes on columns you query by.

### PostgreSQL Configuration

```yaml
spring:
  datasource:
    url: jdbc:postgresql://${DB_HOST:localhost}:${DB_PORT:5432}/${DB_NAME:mydb}
    username: ${DB_USER:app}
    password: ${DB_PASSWORD:secret}
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
      idle-timeout: 300000
      connection-timeout: 20000
  jpa:
    open-in-view: false   # important — disable OSIV to prevent lazy-loading surprises
    hibernate:
      ddl-auto: validate  # Flyway handles schema; Hibernate just validates
    properties:
      hibernate:
        format_sql: true
        default_schema: public
        jdbc:
          batch_size: 25
        order_inserts: true
        order_updates: true
  flyway:
    enabled: true
    locations: classpath:db/migration
```

Always set `open-in-view: false`. OSIV keeps the Hibernate session open for the entire HTTP request, which masks N+1 bugs and ties DB connections to slow responses.

---

## MongoDB with Spring Data

### Document Entity

```java
@Document(collection = "products")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Product {

    @Id
    private String id;

    @Indexed(unique = true)
    private String sku;

    private String name;
    private String description;
    private BigDecimal price;

    @Indexed
    private String category;

    private Map<String, String> attributes;

    private List<String> tags;

    @CreatedDate
    private Instant createdAt;

    @LastModifiedDate
    private Instant updatedAt;
}
```

### Repository

```java
public interface ProductRepository extends MongoRepository<Product, String> {

    Optional<Product> findBySku(String sku);

    List<Product> findByCategoryAndPriceGreaterThan(String category, BigDecimal minPrice);

    @Query("{ 'tags': { $in: ?0 }, 'price': { $lte: ?1 } }")
    Page<Product> findByTagsAndMaxPrice(List<String> tags, BigDecimal maxPrice, Pageable pageable);
}
```

For complex queries, use `MongoTemplate` with `Criteria`:

```java
@RequiredArgsConstructor
public class ProductCustomRepositoryImpl implements ProductCustomRepository {

    private final MongoTemplate mongoTemplate;

    public List<Product> search(ProductSearchCriteria criteria) {
        var query = new Query();

        if (criteria.getCategory() != null) {
            query.addCriteria(Criteria.where("category").is(criteria.getCategory()));
        }
        if (criteria.getMinPrice() != null) {
            query.addCriteria(Criteria.where("price").gte(criteria.getMinPrice()));
        }
        if (criteria.getTags() != null && !criteria.getTags().isEmpty()) {
            query.addCriteria(Criteria.where("tags").in(criteria.getTags()));
        }

        query.with(Sort.by(Sort.Direction.DESC, "createdAt"));
        query.limit(criteria.getLimit());

        return mongoTemplate.find(query, Product.class);
    }
}
```

### MongoDB Configuration

```yaml
spring:
  data:
    mongodb:
      uri: mongodb://${MONGO_HOST:localhost}:${MONGO_PORT:27017}/${MONGO_DB:mydb}
      auto-index-creation: true  # convenient for dev; in prod, manage indexes via migration scripts
```

Enable auditing:

```java
@Configuration
@EnableMongoAuditing
public class MongoConfig {}
```

---

## Redis Caching

### Configuration

```java
@Configuration
@EnableCaching
public class RedisConfig {

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory connectionFactory) {
        var defaultConfig = RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(30))
                .serializeKeysWith(
                        RedisSerializationContext.SerializationPair
                                .fromSerializer(new StringRedisSerializer()))
                .serializeValuesWith(
                        RedisSerializationContext.SerializationPair
                                .fromSerializer(new GenericJackson2JsonRedisSerializer()))
                .disableCachingNullValues();

        // Per-cache TTL overrides
        Map<String, RedisCacheConfiguration> cacheConfigs = Map.of(
                "products", defaultConfig.entryTtl(Duration.ofHours(1)),
                "user-sessions", defaultConfig.entryTtl(Duration.ofMinutes(15))
        );

        return RedisCacheManager.builder(connectionFactory)
                .cacheDefaults(defaultConfig)
                .withInitialCacheConfigurations(cacheConfigs)
                .transactionAware()
                .build();
    }

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory connectionFactory) {
        var template = new RedisTemplate<String, Object>();
        template.setConnectionFactory(connectionFactory);
        template.setKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(new GenericJackson2JsonRedisSerializer());
        template.setHashKeySerializer(new StringRedisSerializer());
        template.setHashValueSerializer(new GenericJackson2JsonRedisSerializer());
        return template;
    }
}
```

### Using Cache Annotations

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class ProductService {

    private final ProductRepository productRepository;

    @Cacheable(value = "products", key = "#id", unless = "#result == null")
    public ProductResponse findById(String id) {
        log.debug("Cache miss for product id={}", id);
        return productRepository.findById(id)
                .map(this::toResponse)
                .orElseThrow(() -> new ResourceNotFoundException("Product", id));
    }

    @CachePut(value = "products", key = "#result.id")
    public ProductResponse update(String id, UpdateProductRequest request) {
        var product = productRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Product", id));
        // apply updates
        return toResponse(productRepository.save(product));
    }

    @CacheEvict(value = "products", key = "#id")
    public void delete(String id) {
        productRepository.deleteById(id);
    }

    @CacheEvict(value = "products", allEntries = true)
    @Scheduled(fixedRate = 3600000)  // hourly cache warm-up / purge if needed
    public void evictAllProducts() {
        log.info("Evicted all product cache entries");
    }
}
```

### Direct RedisTemplate Usage

For patterns beyond simple caching (rate limiting, distributed locks, pub/sub):

```java
@Service
@RequiredArgsConstructor
public class RateLimiter {

    private final RedisTemplate<String, Object> redisTemplate;

    public boolean isAllowed(String clientId, int maxRequests, Duration window) {
        String key = "rate:" + clientId;
        Long count = redisTemplate.opsForValue().increment(key);
        if (count != null && count == 1) {
            redisTemplate.expire(key, window);
        }
        return count != null && count <= maxRequests;
    }
}
```

### Redis Configuration

```yaml
spring:
  data:
    redis:
      host: ${REDIS_HOST:localhost}
      port: ${REDIS_PORT:6379}
      timeout: 2000ms
      lettuce:
        pool:
          max-active: 16
          max-idle: 8
          min-idle: 4
```
