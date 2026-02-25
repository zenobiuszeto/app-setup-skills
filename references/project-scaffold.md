# Project Scaffold

When the user asks to create a new Java microservice from scratch, generate the full project tree below. Adapt the service name, package, and enabled modules based on what the user describes.

## Directory Layout

```
{service-name}/
├── build.gradle
├── settings.gradle
├── gradle.properties
├── gradlew / gradlew.bat
├── Dockerfile
├── docker-compose.yml
├── .github/
│   └── workflows/
│       └── ci.yml                    # see references/cicd-github-actions.md
├── src/
│   ├── main/
│   │   ├── java/com/{org}/{service}/
│   │   │   ├── Application.java
│   │   │   ├── config/
│   │   │   │   ├── AppConfig.java
│   │   │   │   ├── RedisConfig.java          # if caching enabled
│   │   │   │   ├── KafkaConfig.java           # if messaging enabled
│   │   │   │   ├── GrpcConfig.java            # if gRPC enabled
│   │   │   │   └── OpenTelemetryConfig.java   # if observability enabled
│   │   │   ├── controller/
│   │   │   ├── grpc/
│   │   │   ├── service/
│   │   │   ├── repository/
│   │   │   ├── model/
│   │   │   │   ├── entity/
│   │   │   │   ├── dto/
│   │   │   │   └── event/
│   │   │   ├── mapper/
│   │   │   ├── exception/
│   │   │   │   ├── ResourceNotFoundException.java
│   │   │   │   ├── ErrorResponse.java
│   │   │   │   └── GlobalExceptionHandler.java
│   │   │   └── util/
│   │   ├── resources/
│   │   │   ├── application.yml
│   │   │   ├── application-local.yml
│   │   │   ├── application-dev.yml
│   │   │   ├── application-uat.yml
│   │   │   ├── application-prod.yml
│   │   │   └── db/migration/           # Flyway migrations (if SQL DB)
│   │   └── proto/                       # .proto files (if gRPC)
│   └── test/
│       ├── java/com/{org}/{service}/
│       │   ├── controller/
│       │   ├── service/
│       │   ├── repository/
│       │   └── integration/
│       └── resources/
│           └── application-test.yml
├── gatling/                              # see references/gatling-perf.md
│   └── src/
│       └── gatling/
│           └── java/
└── docs/
    └── api.md
```

## build.gradle (Template)

```groovy
plugins {
    id 'java'
    id 'org.springframework.boot' version '3.3.5'
    id 'io.spring.dependency-management' version '1.1.6'
    // Uncomment if using gRPC:
    // id 'com.google.protobuf' version '0.9.4'
}

group = 'com.{org}'
version = '0.0.1-SNAPSHOT'

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

configurations {
    compileOnly {
        extendsFrom annotationProcessor
    }
}

repositories {
    mavenCentral()
}

dependencies {
    // --- Core ---
    implementation 'org.springframework.boot:spring-boot-starter-web'
    implementation 'org.springframework.boot:spring-boot-starter-validation'
    implementation 'org.springframework.boot:spring-boot-starter-actuator'

    // --- Persistence (uncomment what's needed) ---
    // PostgreSQL
    // implementation 'org.springframework.boot:spring-boot-starter-data-jpa'
    // runtimeOnly 'org.postgresql:postgresql'
    // implementation 'org.flywaydb:flyway-core'
    // implementation 'org.flywaydb:flyway-database-postgresql'

    // MongoDB
    // implementation 'org.springframework.boot:spring-boot-starter-data-mongodb'

    // --- Caching ---
    // implementation 'org.springframework.boot:spring-boot-starter-data-redis'
    // implementation 'org.springframework.boot:spring-boot-starter-cache'

    // --- Messaging ---
    // implementation 'org.springframework.kafka:spring-kafka'

    // --- gRPC ---
    // implementation 'net.devh:grpc-spring-boot-starter:3.1.0.RELEASE'
    // implementation 'io.grpc:grpc-protobuf'
    // implementation 'io.grpc:grpc-stub'

    // --- Observability ---
    implementation 'io.micrometer:micrometer-registry-prometheus'
    implementation 'io.opentelemetry.instrumentation:opentelemetry-spring-boot-starter'

    // --- Lombok ---
    compileOnly 'org.projectlombok:lombok'
    annotationProcessor 'org.projectlombok:lombok'

    // --- Testing ---
    testImplementation 'org.springframework.boot:spring-boot-starter-test'
    testImplementation 'org.testcontainers:junit-jupiter'
    // testImplementation 'org.testcontainers:postgresql'
    // testImplementation 'org.testcontainers:mongodb'
    // testImplementation 'org.testcontainers:kafka'
    testRuntimeOnly 'org.junit.platform:junit-platform-launcher'
}

tasks.named('test') {
    useJUnitPlatform()
    jvmArgs '-XX:+EnableDynamicAgentLoading'  // suppress Mockito byte-buddy warnings on Java 21
}

// --- gRPC protobuf compilation (uncomment if using gRPC) ---
// protobuf {
//     protoc { artifact = 'com.google.protobuf:protoc:3.25.5' }
//     plugins {
//         grpc { artifact = 'io.grpc:protoc-gen-grpc-java:1.68.1' }
//     }
//     generateProtoTasks {
//         all()*.plugins { grpc {} }
//     }
// }
```

## Application.java

```java
package com.{org}.{service};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;

@SpringBootApplication
@EnableCaching  // remove if Redis not used
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

## application.yml (Base)

```yaml
spring:
  application:
    name: {service-name}
  profiles:
    active: local

server:
  port: 8080
  shutdown: graceful

management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,metrics
  endpoint:
    health:
      show-details: when_authorized
  metrics:
    tags:
      application: ${spring.application.name}
  tracing:
    sampling:
      probability: 1.0  # lower in prod

logging:
  level:
    root: INFO
    com.{org}.{service}: DEBUG
  pattern:
    console: "%d{ISO8601} [%thread] [%X{traceId}] %-5level %logger{36} - %msg%n"
```

## Dockerfile (Multi-stage)

```dockerfile
# --- Build stage ---
FROM eclipse-temurin:21-jdk AS build
WORKDIR /app
COPY gradle/ gradle/
COPY gradlew build.gradle settings.gradle gradle.properties ./
RUN ./gradlew dependencies --no-daemon || true
COPY src/ src/
RUN ./gradlew bootJar --no-daemon -x test

# --- Runtime stage ---
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=build /app/build/libs/*.jar app.jar
USER appuser

ENV JAVA_OPTS="-XX:MaxRAMPercentage=75.0 -XX:+UseZGC"
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/actuator/health || exit 1

ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]
```

## docker-compose.yml (Local Dev)

```yaml
version: '3.9'

services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      SPRING_PROFILES_ACTIVE: local
      SPRING_DATASOURCE_URL: jdbc:postgresql://postgres:5432/{service_db}
      SPRING_DATASOURCE_USERNAME: app
      SPRING_DATASOURCE_PASSWORD: secret
      SPRING_DATA_MONGODB_URI: mongodb://mongo:27017/{service_db}
      SPRING_DATA_REDIS_HOST: redis
      SPRING_KAFKA_BOOTSTRAP_SERVERS: kafka:9092
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
    depends_on:
      postgres:
        condition: service_healthy
      mongo:
        condition: service_started
      redis:
        condition: service_healthy
      kafka:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: {service_db}
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d {service_db}"]
      interval: 5s
      retries: 5

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongodata:/data/db

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 5

  kafka:
    image: apache/kafka:3.7.0
    ports:
      - "9092:9092"
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_LOG_DIRS: /tmp/kraft-combined-logs
      CLUSTER_ID: 'MkU3OEVBNTcwNTJENDM2Qk'
    healthcheck:
      test: ["CMD-SHELL", "/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list"]
      interval: 10s
      retries: 10

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./infra/prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafana-storage:/var/lib/grafana

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    ports:
      - "4317:4317"   # gRPC
      - "4318:4318"   # HTTP
    volumes:
      - ./infra/otel-collector-config.yml:/etc/otelcol-contrib/config.yaml

volumes:
  pgdata:
  mongodata:
  grafana-storage:
```

Adapt this template: remove containers the user doesn't need and uncomment the corresponding build.gradle dependencies.
