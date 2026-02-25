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
├── zap-rules.conf                         # OWASP ZAP DAST rules
├── infra/
│   ├── prometheus.yml                     # Prometheus scrape config
│   └── otel-collector-config.yml          # OpenTelemetry Collector config
├── config/
│   ├── checkstyle.xml                     # Checkstyle rules
│   ├── pmd-rules.xml                      # PMD rules
│   ├── spotbugs-exclude.xml               # SpotBugs exclusion filter
│   └── dependency-check-suppressions.xml  # OWASP dependency check suppressions
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                         # see references/cicd-github-actions.md
│   │   ├── cd.yml                         # see references/cicd-github-actions.md
│   │   └── nightly-security.yml           # see references/cicd-github-actions.md
│   └── actions/
│       └── deploy/
│           └── action.yml                 # reusable deploy action
├── helm/
│   └── {service}/                         # see references/kubernetes.md
│       ├── Chart.yaml
│       ├── values.yaml
│       ├── values-dev.yaml
│       ├── values-uat.yaml
│       ├── values-prod.yaml
│       └── templates/
├── k8s/                                   # raw manifests (alternative to Helm)
│   ├── namespace.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── hpa.yaml
│   └── pdb.yaml
├── src/
│   ├── main/
│   │   ├── java/com/{org}/{service}/
│   │   │   ├── Application.java
│   │   │   ├── config/
│   │   │   │   ├── AppConfig.java
│   │   │   │   ├── SecurityConfig.java        # see references/security.md
│   │   │   │   ├── CorsConfig.java
│   │   │   │   ├── RedisConfig.java           # if caching enabled
│   │   │   │   ├── KafkaConfig.java           # if messaging enabled
│   │   │   │   ├── GrpcConfig.java            # if gRPC enabled
│   │   │   │   └── OpenTelemetryConfig.java   # if observability enabled
│   │   │   ├── controller/
│   │   │   ├── grpc/
│   │   │   ├── service/
│   │   │   ├── repository/
│   │   │   ├── security/
│   │   │   │   ├── OrderSecurityService.java  # ownership checks
│   │   │   │   ├── RateLimitFilter.java       # rate limiting
│   │   │   │   └── SecurityAuditListener.java # audit logging
│   │   │   ├── model/
│   │   │   │   ├── entity/
│   │   │   │   ├── dto/
│   │   │   │   └── event/
│   │   │   ├── mapper/
│   │   │   ├── exception/
│   │   │   │   ├── ResourceNotFoundException.java
│   │   │   │   ├── ErrorResponse.java
│   │   │   │   └── GlobalExceptionHandler.java
│   │   │   ├── filter/
│   │   │   └── util/
│   │   ├── resources/
│   │   │   ├── application.yml
│   │   │   ├── application-local.yml
│   │   │   ├── application-dev.yml
│   │   │   ├── application-uat.yml
│   │   │   ├── application-prod.yml
│   │   │   └── db/migration/              # Flyway migrations (if SQL DB)
│   │   └── proto/                          # .proto files (if gRPC)
│   ├── test/
│   │   ├── java/com/{org}/{service}/
│   │   │   ├── controller/                 # MockMvc + @WithMockUser security tests
│   │   │   ├── service/                    # unit tests (JUnit 5 + Mockito)
│   │   │   ├── repository/
│   │   │   └── regression/                 # @Tag("regression") tests
│   │   └── resources/
│   │       ├── application-test.yml
│   │       ├── regression-seed.sql
│   │       └── regression-cleanup.sql
│   ├── integrationTest/
│   │   ├── java/com/{org}/{service}/
│   │   │   └── integration/                # @SpringBootTest + Testcontainers
│   │   └── resources/
│   │       └── application-integrationtest.yml
│   └── functionalTest/
│       ├── java/
│       │   ├── runner/
│       │   │   └── CucumberTestRunner.java
│       │   ├── steps/                       # Cucumber step definitions
│       │   ├── config/
│       │   │   └── CucumberSpringConfig.java
│       │   └── api/                         # REST Assured API tests
│       └── resources/
│           ├── features/                    # .feature files (Gherkin)
│           └── application-functional.yml
├── gatling/                                 # see references/gatling-perf.md
│   └── src/
│       └── gatling/
│           └── java/simulations/
│               ├── SmokeSuite.java
│               ├── RegressionSuite.java
│               ├── OrderApiLoadTest.java
│               └── StressTest.java
└── docs/
    └── api.md
```

## settings.gradle

```groovy
rootProject.name = '{service-name}'
```

## gradle.properties

```properties
# Gradle performance
org.gradle.caching=true
org.gradle.parallel=true
org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8

# Spring Boot dependency management
springBootVersion=3.3.5
springDependencyManagementVersion=1.1.6
```

## gradle/wrapper/gradle-wrapper.properties

```properties
distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://services.gradle.org/distributions/gradle-8.10-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
```

## build.gradle (Template)

```groovy
plugins {
    id 'java'
    id 'org.springframework.boot' version '3.3.5'
    id 'io.spring.dependency-management' version '1.1.6'
    id 'jacoco'
    id 'checkstyle'
    id 'pmd'
    id 'com.github.spotbugs' version '6.0.18'
    id 'org.sonarqube' version '5.1.0.4882'
    id 'org.owasp.dependencycheck' version '10.0.3'
    // Uncomment if using gRPC:
    // id 'com.google.protobuf' version '0.9.4'
    // Uncomment if using Gatling:
    // id 'io.gatling.gradle' version '3.11.5.2'
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

    // --- Security ---
    implementation 'org.springframework.boot:spring-boot-starter-security'
    implementation 'org.springframework.boot:spring-boot-starter-oauth2-resource-server'

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
    testImplementation 'org.springframework.security:spring-security-test'
    testImplementation 'org.testcontainers:junit-jupiter'
    // testImplementation 'org.testcontainers:postgresql'
    // testImplementation 'org.testcontainers:mongodb'
    // testImplementation 'org.testcontainers:kafka'
    testRuntimeOnly 'org.junit.platform:junit-platform-launcher'

    // --- Functional / BDD Tests ---
    // functionalTestImplementation 'io.cucumber:cucumber-java:7.18.1'
    // functionalTestImplementation 'io.cucumber:cucumber-spring:7.18.1'
    // functionalTestImplementation 'io.cucumber:cucumber-junit-platform-engine:7.18.1'
    // functionalTestImplementation 'io.rest-assured:rest-assured:5.4.0'
}

tasks.named('test') {
    useJUnitPlatform()
    jvmArgs '-XX:+EnableDynamicAgentLoading'  // suppress Mockito byte-buddy warnings on Java 21
    finalizedBy jacocoTestReport
}

// --- JaCoCo ---
jacoco {
    toolVersion = '0.8.12'
}
jacocoTestReport {
    dependsOn test
    reports {
        xml.required = true
        html.required = true
    }
}
jacocoTestCoverageVerification {
    violationRules {
        rule {
            element = 'CLASS'
            excludes = ['*.*Application', '*.config.*', '*.model.*']
            limits {
                counter = 'LINE'
                value = 'COVEREDRATIO'
                minimum = 0.80
            }
        }
    }
}
check.dependsOn jacocoTestCoverageVerification

// --- Code quality ---
checkstyle {
    toolVersion = '10.18.2'
    configFile = file('config/checkstyle.xml')
}
pmd {
    toolVersion = '7.5.0'
    ruleSets = []
    ruleSetFiles = files('config/pmd-rules.xml')
}
spotbugs {
    effort = 'max'
    reportLevel = 'medium'
    excludeFilter = file('config/spotbugs-exclude.xml')
}
spotbugsMain.reports {
    html.required = true
    xml.required = true
}

// --- SonarQube ---
sonar {
    properties {
        property 'sonar.projectKey', '{org}_{service}'
        property 'sonar.host.url', System.getenv('SONAR_HOST_URL') ?: 'https://sonarcloud.io'
        property 'sonar.organization', '{org}'
        property 'sonar.coverage.jacoco.xmlReportPaths', 'build/reports/jacoco/test/jacocoTestReport.xml'
    }
}

// --- OWASP Dependency Check ---
dependencyCheck {
    failBuildOnCVSS = 7.0
    suppressionFile = 'config/dependency-check-suppressions.xml'
    formats = ['HTML', 'JSON']
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

## zap-rules.conf

```
# OWASP ZAP scan rules configuration
# Disable false-positive rules; adjust thresholds as needed

# 10016 - Web Browser XSS Protection Not Enabled — INFO only for APIs
10016	IGNORE

# 10020 - X-Frame-Options Header Not Set — acceptable for pure APIs
10020	IGNORE

# 10021 - X-Content-Type-Options Header Missing
10021	WARN

# 10036 - Server Leaks Version Info via "Server" HTTP Header
10036	WARN

# 10096 - Timestamp Disclosure
10096	IGNORE

# 40012 - Cross-Site Scripting (Reflected)
40012	FAIL

# 40014 - Cross-Site Scripting (Persistent)
40014	FAIL

# 40018 - SQL Injection
40018	FAIL

# 90020 - Remote OS Command Injection
90020	FAIL
```

## config/dependency-check-suppressions.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<suppressions xmlns="https://jeremylong.github.io/DependencyCheck/dependency-suppression.1.3.xsd">
    <!--
        Add suppressions for known false positives here.
        Always add a comment explaining why the CVE is suppressed and
        set an expiry date so suppressions are reviewed periodically.
    -->
    <!--
    <suppress until="2026-01-01Z">
        <notes>CVE-YYYY-NNNNN: False positive — library not used at runtime.
               Review again before expiry date.</notes>
        <packageUrl regex="true">^pkg:maven/com\.example/some\-library@.*$</packageUrl>
        <cve>CVE-YYYY-NNNNN</cve>
    </suppress>
    -->
</suppressions>
```

## infra/prometheus.yml

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: '{service-name}'
    metrics_path: /actuator/prometheus
    static_configs:
      - targets: ['app:8080']
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance

  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
```

## infra/otel-collector-config.yml

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024
  memory_limiter:
    check_interval: 1s
    limit_mib: 256

exporters:
  debug:
    verbosity: normal
  # Uncomment and configure to forward to a tracing backend:
  # otlp/jaeger:
  #   endpoint: jaeger:4317
  #   tls:
  #     insecure: true
  # prometheus:
  #   endpoint: "0.0.0.0:8889"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug]
```

## README.md (Template)

````markdown
# {service-name}

Brief description of what this service does and which domain it owns.

## Prerequisites

| Tool | Version |
|------|---------|
| Java | 21 |
| Gradle | 8.x (via wrapper) |
| Docker + Docker Compose | 24+ |
| kubectl | 1.30+ (for K8s deploy) |
| Helm | 3.x (for K8s deploy) |

## Quick Start (Local)

```bash
# 1. Start all infrastructure (Postgres, Kafka, Redis, Prometheus, Grafana, OTEL Collector)
docker-compose up -d postgres redis kafka otel-collector

# 2. Run the application
./gradlew bootRun --args='--spring.profiles.active=local'
# OR build and run via Docker
docker-compose up --build app
```

The service starts on **http://localhost:8080**.

| Endpoint | URL |
|---|---|
| Health | http://localhost:8080/actuator/health |
| API docs (Swagger UI) | http://localhost:8080/swagger-ui.html |
| Metrics | http://localhost:8080/actuator/prometheus |
| Grafana | http://localhost:3000 (admin/admin) |
| Prometheus | http://localhost:9090 |

## Build

```bash
# Compile + unit tests
./gradlew build

# Skip tests (faster iteration)
./gradlew build -x test

# Build Docker image locally
docker build -t {service-name}:local .
```

## Test

```bash
# Unit tests
./gradlew test

# Integration tests (requires Docker for Testcontainers)
./gradlew integrationTest

# Regression tests
./gradlew regressionTest

# Functional / BDD tests (requires a running environment)
TEST_BASE_URL=http://localhost:8080 ./gradlew functionalTest

# All tests + coverage report
./gradlew test integrationTest jacocoTestReport
open build/reports/jacoco/test/html/index.html
```

## Code Quality

```bash
# Run all quality checks (Checkstyle, PMD, SpotBugs, JaCoCo)
./gradlew check

# SonarQube analysis (requires SONAR_TOKEN env var)
./gradlew sonar
```

## Deploy

See [`.github/workflows/cd.yml`](.github/workflows/cd.yml) for the full CI/CD pipeline.

Manual deploy via Helm:

```bash
# Dev
helm upgrade --install {service-name} helm/{service-name} \
  --namespace {service-name}-dev --create-namespace \
  --values helm/{service-name}/values-dev.yaml \
  --set image.tag=<IMAGE_TAG>

# Production
helm upgrade --install {service-name} helm/{service-name} \
  --namespace {service-name} --create-namespace \
  --values helm/{service-name}/values-prod.yaml \
  --set image.tag=<IMAGE_TAG>
```

## Project Structure

```
src/main/java/com/{org}/{service}/
├── config/          # Spring @Configuration classes
├── controller/      # REST controllers
├── service/         # Business logic
├── repository/      # Spring Data repositories
├── security/        # Security beans and filters
├── model/
│   ├── entity/      # JPA / Mongo entities
│   ├── dto/         # Request / response DTOs
│   └── event/       # Kafka event payloads
├── mapper/          # Object mappers
├── exception/       # Custom exceptions + GlobalExceptionHandler
├── filter/          # Servlet filters
└── util/            # Shared helpers
```

## Configuration

| Profile | Purpose |
|---|---|
| `local` | Local dev with docker-compose |
| `dev` | DEV K8s environment |
| `uat` | UAT K8s environment |
| `prod` | Production K8s environment |

Secrets are never hardcoded — supply them via environment variables or Vault.
````

## Local Development — Build and Run

```bash
# One-time: make Gradle wrapper executable
chmod +x gradlew

# Start only the infrastructure services needed locally
docker-compose up -d postgres redis kafka

# Run the app in dev mode (live reload via Spring DevTools if added)
./gradlew bootRun --args='--spring.profiles.active=local'

# Run the full local stack including the app
docker-compose up --build

# Tear down
docker-compose down -v
```

Useful Gradle tasks during development:

| Task | Description |
|---|---|
| `./gradlew build` | Compile, test, and assemble the JAR |
| `./gradlew build -x test` | Build without tests (faster iteration) |
| `./gradlew bootRun` | Run the app with Spring Boot devtools |
| `./gradlew test` | Unit tests only |
| `./gradlew integrationTest` | Integration tests (needs Docker) |
| `./gradlew check` | All quality checks (Checkstyle, PMD, SpotBugs, JaCoCo) |
| `./gradlew dependencyCheckAnalyze` | OWASP dependency vulnerability scan |
| `./gradlew bootJar` | Build the executable fat JAR only |

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
