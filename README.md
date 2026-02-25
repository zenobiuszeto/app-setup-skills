# Java Backend Copilot — Skills & Instructions

A workspace that ships **two complementary layers of AI assistance** for Java backend microservice development:

| Layer | File / Folder | How it works |
|---|---|---|
| **Passive instructions** | `.github/copilot-instructions.md` | Injected into every Copilot prompt automatically — zero setup |
| **Active extension skills** | `copilot-extension/` | A live Node.js server Copilot calls at runtime to execute real logic |

---

## Workspace Structure

```
.
├── .github/
│   └── copilot-instructions.md   ← passive rules (always on)
├── references/                   ← source of truth for all patterns
│   ├── api-design.md
│   ├── core-java.md
│   ├── persistence.md
│   ├── kafka.md
│   ├── observability.md
│   ├── cicd-github-actions.md
│   ├── gatling-perf.md
│   ├── jfr-profiling.md
│   └── project-scaffold.md
└── copilot-extension/            ← active skill server
    ├── src/
    │   ├── server.ts             ← Express entry point
    │   ├── handler.ts            ← agentic loop + SSE streaming
    │   ├── verify.ts             ← GitHub signature verification
    │   ├── types.ts              ← shared TypeScript types
    │   └── skills/
    │       ├── index.ts          ← tool registry + dispatcher
    │       ├── validateEntity.ts ← JPA entity validation skill
    │       ├── nextMigration.ts  ← Flyway version calculator skill
    │       ├── checkKafkaTopic.ts← Kafka topic config checker skill
    │       └── getReference.ts   ← reference guide lookup skill
    ├── manifest/
    │   └── app-manifest.json     ← GitHub App manifest
    ├── .env.example
    ├── package.json
    ├── tsconfig.json
    └── README.md                 ← detailed extension setup guide
```

---

## Layer 1 — Passive Instructions (`copilot-instructions.md`)

### What it does

The file `.github/copilot-instructions.md` is read automatically by GitHub Copilot for every chat message and inline suggestion in this workspace. It encodes the **non-negotiable conventions** derived from the `references/` folder:

- Stack defaults (Java 21, Spring Boot 3.3, Gradle, PostgreSQL, Kafka, OTel)
- Full project scaffold rules (directory layout, required files, enabled modules)
- REST API design (URL conventions, controller skeleton, DTOs, pagination)
- gRPC patterns (proto conventions, error mapping)
- Core Java 21 patterns (virtual threads, records, sealed classes, pattern matching)
- Persistence rules (JPA entity design, Flyway migrations, MongoDB, Redis caching)
- Kafka messaging (producer/consumer config, event model, idempotency)
- Observability (OTel tracing, Micrometer metrics, Prometheus, Grafana alerts)
- CI/CD (two-workflow GitHub Actions structure, promotion gates)
- Gatling performance tests (smoke, load, stress simulation types)
- JFR profiling (custom events, virtual thread pinning detection)

### How to use it

**Nothing to install.** Open this workspace in VS Code with the GitHub Copilot extension and start prompting:

```
Create a new order-service microservice with PostgreSQL and Kafka
```

```
Add a REST controller for the Payment resource with pagination
```

```
Write an OrderCreatedEvent for Kafka with all required fields
```

```
Generate a Flyway migration for a payments table
```

Copilot will follow all patterns from `copilot-instructions.md` automatically — correct package structure, proper Lombok annotations, virtual threads enabled, `open-in-view: false`, and so on.

### Referencing a specific guide

To pull in a specific reference while chatting:

```
Using the persistence reference, add a MongoDB product document entity
```

```
Following the observability reference, add custom Micrometer metrics to OrderService
```

---

## Layer 2 — Active Extension Skills (`copilot-extension/`)

### What it does

A **GitHub Copilot Extension** that Copilot calls as tools during agentic chat. Unlike the passive instructions, skills can execute real logic against your code — validating, calculating, and looking up live data.

### Available skills

| Skill | Invoke with | What it does |
|---|---|---|
| `validate_jpa_entity` | `@java-backend validate this entity class` | Runs 7 checks: `@Data` misuse, `@EqualsAndHashCode(onlyExplicitlyIncluded=true)`, `GenerationType.UUID`, `@Builder.Default` on collections, lifecycle timestamps |
| `next_flyway_version` | `@java-backend what's the next migration version?` | Parses existing `V{N}__*.sql` filenames → returns next version + `V{N}__desc.sql` filename + DDL skeleton |
| `check_kafka_topic` | `@java-backend is order-events configured?` | Scans your `KafkaTopicConfig` source for the topic bean + its `.DLT` companion; generates the missing snippet if absent |
| `get_reference` | `@java-backend show me the kafka reference` | Returns the full content of any `references/*.md` file — supports all 9 topics |

### Quick start (local development)

**Prerequisites:** Node.js ≥ 20, [ngrok](https://ngrok.com/)

```bash
# 1. Install dependencies
cd copilot-extension
npm install

# 2. Copy and fill in environment variables
cp .env.example .env
# → edit .env: set GITHUB_WEBHOOK_SECRET after creating the GitHub App below
```

**Terminal 1 — start the ngrok tunnel:**
```bash
ngrok http 3000
# Note the HTTPS URL, e.g. https://abc123.ngrok-free.app
```

**Terminal 2 — start the extension server:**
```bash
npm run dev
```

### Register the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set **Webhook URL** to your ngrok HTTPS URL
3. Copy the **Webhook secret** into `.env` as `GITHUB_WEBHOOK_SECRET`
4. Under **Permissions → Account permissions → Copilot Chat**: `Read`
5. **Create** the app, then go to its **Copilot** tab:
   - App type: **Agent**
   - URL: your ngrok URL
6. **Install** the app on your account

> See [`copilot-extension/README.md`](copilot-extension/README.md) for the full walkthrough including Docker deployment.

### Example prompts (after installing the extension)

```
@java-backend validate this entity:

@Entity
@Table(name = "orders")
@Data
public class Order {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    ...
}
```

```
@java-backend I have these migrations: V1__create_users.sql, V2__add_orders.sql
What's the next version for adding a payments table?
```

```
@java-backend check if payment-events is properly configured:

@Configuration
public class KafkaTopicConfig {
    @Bean
    public NewTopic orderEventsTopic() {
        return TopicBuilder.name("order-events").partitions(6).replicas(3).build();
    }
}
```

---

## Reference Guides

All conventions live in the `references/` folder. Each file is the authoritative source for its topic:

| File | Topic |
|---|---|
| [`references/project-scaffold.md`](references/project-scaffold.md) | Full directory layout, `build.gradle` template, `Dockerfile`, `docker-compose.yml` |
| [`references/api-design.md`](references/api-design.md) | REST controller skeleton, DTO records, pagination, gRPC patterns, `RestClient` usage |
| [`references/core-java.md`](references/core-java.md) | Virtual threads, records, sealed classes, pattern matching, text blocks, Stream/Optional |
| [`references/persistence.md`](references/persistence.md) | JPA entity design, Flyway migrations, MongoDB documents, Redis cache configuration |
| [`references/kafka.md`](references/kafka.md) | Producer/consumer config, event model, idempotency, DLT, Testcontainers integration tests |
| [`references/observability.md`](references/observability.md) | OTel tracing (agent + manual spans), Micrometer metrics, Prometheus PromQL, Grafana dashboards, alert rules |
| [`references/cicd-github-actions.md`](references/cicd-github-actions.md) | CI workflow (build/test/docker), CD workflow (Dev→UAT→Prod promotion gates), Gradle source sets |
| [`references/gatling-perf.md`](references/gatling-perf.md) | Smoke / load / stress simulations (Java DSL), assertions, CSV feeders, Gradle plugin |
| [`references/jfr-profiling.md`](references/jfr-profiling.md) | JFR startup flags, custom business events, virtual thread pinning, admin profiling endpoint |

---

## Passive vs Active — When to Use Each

| Scenario | Use |
|---|---|
| Writing new code that must follow conventions | Passive (`copilot-instructions.md`) — always active |
| Asking Copilot to scaffold a new service | Passive — Copilot reads the scaffold reference automatically |
| Validating an existing entity before a PR | Active (`@java-backend validate...`) |
| Confirming the next Flyway migration filename | Active (`@java-backend next version...`) |
| Checking a Kafka topic is correctly declared | Active (`@java-backend check topic...`) |
| Looking up a specific pattern or code template | Either — Active gives the full raw guide; Passive applies it contextually |
