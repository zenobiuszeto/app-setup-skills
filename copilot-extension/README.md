# Java Backend Copilot Extension

A **GitHub Copilot Extension** built with **Spring Boot 3.3 + Java 21** that exposes active skills for Java backend microservices development. Unlike the passive `copilot-instructions.md` (which injects conventions as prompt context), this extension runs as a live Spring Boot server that Copilot calls at runtime to execute real logic against your code.

Everything here follows the same Java stack used in your microservices — Spring Boot, virtual threads, Lombok, Gradle.

---

## Architecture

```
User: "@java-backend validate this entity class"
         │
         ▼
   GitHub Copilot model
         │ decides to call validate_jpa_entity tool
         ▼
   POST https://your-host/ ← Spring Boot CopilotController
         │ GitHubSignatureVerifier validates ECDSA signature
         │ AgentHandler runs the agentic loop
         │ SkillDispatcher routes to the correct @Service
         ▼
   Skill @Service executes logic, returns Markdown report
         │
         ▼
   AgentHandler streams SSE back → Copilot → user
```

### Spring Boot components

| Class | Role |
|---|---|
| `CopilotController` | `POST /` endpoint — verifies signature, opens SSE stream |
| `GitHubSignatureVerifier` | ECDSA-P256 verification against GitHub's public keys |
| `AgentHandler` | Agentic loop — calls Copilot API, executes tool calls, streams deltas |
| `SkillDispatcher` | Routes tool-call names to skill `@Service` beans |
| `ValidateEntitySkill` | JPA entity static analysis |
| `NextMigrationSkill` | Flyway version calculator |
| `CheckKafkaTopicSkill` | Kafka topic config checker |
| `GetReferenceSkill` | Reference guide reader (filesystem + GitHub API) |

---

## Skills

| Skill | Trigger example | What it does |
|---|---|---|
| `validate_jpa_entity` | "validate this entity" | Checks `@Data` misuse, `@EqualsAndHashCode`, `GenerationType.UUID`, `@Builder.Default` on collections |
| `next_flyway_version` | "what's the next migration version?" | Parses existing filenames → returns next `V{N}__description.sql` with DDL skeleton |
| `check_kafka_topic` | "is order-events configured?" | Scans `KafkaTopicConfig` for topic + DLT bean declarations |
| `get_reference` | "show me the persistence reference" | Reads `references/{topic}.md` and returns the full guide |

---

## Prerequisites

- Java 21 (Temurin recommended)
- Gradle (or use the `./gradlew` wrapper — no install needed)
- A GitHub account with access to create GitHub Apps
- A public HTTPS URL for your extension server — any of these work for local dev:
  - Deploy to a free-tier cloud (Railway, Render, Fly.io) — push once, get a stable URL
  - Use a reverse proxy you already have
  - GitHub Codespaces port forwarding (built into VS Code)

---

## Local Development Setup

### 1. Build and run the Spring Boot server

```bash
cd copilot-extension

# Run locally (profile=local auto-sets references-path to ../../references)
./gradlew bootRun

# Or build a runnable JAR
./gradlew bootJar
java -jar build/libs/copilot-extension-1.0.0-SNAPSHOT.jar
```

The server starts on **port 3000** (`server.port=3000` in `application.yml`).

### 2. Expose the server with a public HTTPS URL

You need a stable public HTTPS URL so GitHub can reach the server. Choose one:

**Option A — GitHub Codespaces (recommended for development)**
1. Open this repo in a GitHub Codespace
2. Run `./gradlew bootRun` in the terminal
3. VS Code will automatically forward port 3000 and show a public URL in the **Ports** tab
4. Right-click the port → **Port Visibility → Public**

**Option B — Deploy to Railway / Render / Fly.io (free tier)**
```bash
# Railway example — from copilot-extension/ folder
railway init && railway up
# Returns: https://java-backend-copilot-extension-production.up.railway.app
```

**Option C — Any server / VPS you already have**
```bash
# Copy the JAR and run it
scp build/libs/*.jar user@yourserver:/opt/copilot-extension/
ssh user@yourserver "java -DGITHUB_WEBHOOK_SECRET=xxx -jar /opt/copilot-extension/app.jar"
```

### 3. Set environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | ✅ | From your GitHub App settings |
| `REFERENCES_PATH` | optional | Absolute path to `references/` folder. Default: `../../references` |
| `GITHUB_REPO` | optional | `owner/repo` — enables GitHub API fallback for `get_reference` |

For local dev, set them in `application-local.yml` or as env vars:
```bash
export GITHUB_WEBHOOK_SECRET=your_secret_here
./gradlew bootRun
```

### 4. Create the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in:
   - **GitHub App name**: `Java Backend Skills`
   - **Homepage URL**: your public server URL
   - **Webhook URL**: `https://<your-public-url>/`
   - **Webhook secret**: a random string → set as `GITHUB_WEBHOOK_SECRET`
3. Under **Permissions → Account permissions → Copilot Chat**: set to **Read**
4. Click **Create GitHub App**

### 5. Enable the Copilot Extension

1. GitHub App page → **Copilot** tab
2. Set **App type** to **Agent**
3. Set **URL** to your public server URL
4. Paste content from `manifest/app-manifest.json` into the description fields
5. Save

### 6. Install the app on your account

GitHub App page → **Install App** → select your account or org

### 7. Test in Copilot Chat

In VS Code Copilot Chat, type:
```
@java-backend validate this entity:

@Entity
@Table(name = "orders")
@Data
public class Order { ... }
```

---

## Production Deployment

### Docker

A `Dockerfile` (multi-stage, Eclipse Temurin 21) is included in this folder.

```bash
# From copilot-extension/ directory
./gradlew bootJar
docker build -t java-backend-copilot-extension .
docker run -p 3000:3000 \
  -e GITHUB_WEBHOOK_SECRET=your_secret \
  -e REFERENCES_PATH=/app/references \
  -v /path/to/your/references:/app/references:ro \
  java-backend-copilot-extension
```

### Update GitHub App webhook URL

After deploying, update the **Webhook URL** in your GitHub App settings to point to your production host URL.

---

## Request Flow (Technical)

```
1. GitHub           → POST /  (X-GitHub-Public-Key-Signature + X-GitHub-Token)
2. CopilotController → GitHubSignatureVerifier.verify() — ECDSA-P256 check
3. CopilotController → opens SSE PrintWriter, calls AgentHandler.stream()
4. AgentHandler      → POST messages + SkillDispatcher.TOOL_DEFINITIONS to Copilot API
5. Copilot model     → finish_reason="tool_calls" with skill name + JSON args
6. AgentHandler      → SkillDispatcher.execute(skillName, args) → @Service skill
7. AgentHandler      → appends tool result to messages; loop repeats (max 5×)
8. Copilot model     → returns final text answer (content delta stream)
9. AgentHandler      → proxies SSE content deltas to PrintWriter → GitHub → user
```

---

## Extending with New Skills

1. Create `src/main/java/com/javabackend/copilot/service/skills/MyNewSkill.java` — annotate with `@Service`, implement your logic, return a `String` (Markdown).
2. Add a `ToolDefinition` entry to `SkillDispatcher.TOOL_DEFINITIONS`.
3. Inject `MyNewSkill` into `SkillDispatcher` via `@RequiredArgsConstructor` and add a `case "my_new_skill":` branch in `execute()`.
4. Run `./gradlew bootJar` and redeploy.

---

## Comparison: Passive vs Active Skills

| | `copilot-instructions.md` | This Extension |
|---|---|---|
| **Type** | Passive (prompt context) | Active (tool calls) |
| **Setup** | None — just a file | GitHub App + hosted server |
| **Reads live code** | ❌ | ✅ |
| **Executes logic** | ❌ | ✅ |
| **Works offline** | ✅ | ❌ (needs server) |
| **Latency** | Zero | ~200–500ms per tool call |

Use both together: `copilot-instructions.md` sets the ground rules passively;
this extension handles dynamic validation and lookups on demand.
