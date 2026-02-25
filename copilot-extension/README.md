# Java Backend Copilot Extension

A **GitHub Copilot Extension** that exposes active skills for Java backend microservices development. Unlike the passive `copilot-instructions.md` (which injects conventions as prompt context), this extension runs as a live server that Copilot calls at runtime to execute real logic against your code.

---

## Architecture

```
User: "@java-backend validate this entity class"
         │
         ▼
   GitHub Copilot model
         │ decides to call validate_jpa_entity tool
         ▼
   POST https://your-host/ (this extension)
         │ executes skill, returns structured report
         ▼
   Copilot streams the report back to the user
```

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

- Node.js ≥ 20
- A GitHub account with access to create GitHub Apps
- [ngrok](https://ngrok.com/) for local development tunnelling

---

## Local Development Setup

### 1. Install dependencies

```bash
cd copilot-extension
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — fill in GITHUB_WEBHOOK_SECRET after creating the GitHub App below
```

### 3. Start ngrok tunnel

```bash
ngrok http 3000
# Note the HTTPS forwarding URL, e.g. https://abc123.ngrok-free.app
```

### 4. Create the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in:
   - **GitHub App name**: `Java Backend Skills (dev)`
   - **Homepage URL**: your ngrok URL
   - **Webhook URL**: `https://<ngrok-url>/`
   - **Webhook secret**: a random string (copy it into `.env` as `GITHUB_WEBHOOK_SECRET`)
3. Under **Permissions → Account permissions → Copilot Chat**: set to **Read**
4. Under **Where can this GitHub App be installed?**: **Only on this account**
5. Click **Create GitHub App**

### 5. Enable the Copilot Extension

1. On the GitHub App page → **Copilot** tab
2. Set **App type** to **Agent**
3. Set **URL** to your ngrok URL
4. Paste `manifest/app-manifest.json` content into the description fields
5. Save

### 6. Install the app on your account

GitHub App page → **Install App** → select your account or org

### 7. Start the extension server

```bash
# Development (watch mode)
npm run dev

# Production build
npm run build && npm start
```

### 8. Test in Copilot Chat

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

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | ✅ | From your GitHub App settings |
| `PORT` | optional | Default: `3000` |
| `REFERENCES_PATH` | optional | Absolute path to `references/` folder |
| `GITHUB_REPO` | optional | `owner/repo` — enables GitHub API fallback for `get_reference` |

### Using Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ dist/
COPY ../references/ references/
ENV REFERENCES_PATH=/app/references
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Build and run:

```bash
npm run build
docker build -t java-backend-copilot-extension .
docker run -p 3000:3000 \
  -e GITHUB_WEBHOOK_SECRET=your_secret \
  java-backend-copilot-extension
```

### Update GitHub App webhook URL

After deploying, update the **Webhook URL** in your GitHub App settings to point to your production host.

---

## Request Flow (Technical)

```
1. GitHub  → POST /  (with X-GitHub-Public-Key-Signature + X-GitHub-Token)
2. verify.ts  → ECDSA signature verified against GitHub's public key
3. handler.ts → SSE stream opened; sseAck() sent
4. agentLoop  → messages + TOOL_DEFINITIONS sent to api.githubcopilot.com
5. Model       → returns finish_reason: "tool_calls" with skill name + args
6. skills/     → skill function executed locally
7. agentLoop  → tool result appended to messages; loop repeats
8. Model       → returns final text answer
9. handler.ts → sseText() chunks proxied to GitHub; sseDone() closes stream
```

---

## Extending with New Skills

1. Create `src/skills/myNewSkill.ts` — export a function that takes `(args) => string`
2. Add the `ToolDefinition` entry to `src/skills/index.ts` → `TOOL_DEFINITIONS`
3. Add the `case 'my_new_skill':` branch to `executeTool()` in `src/skills/index.ts`
4. Rebuild and redeploy

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
