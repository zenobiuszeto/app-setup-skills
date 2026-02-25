import 'dotenv/config';
import express from 'express';
import { handleCopilotRequest } from './handler';

const app = express();

// Raw body is required for ECDSA signature verification
app.use(express.raw({ type: 'application/json' }));

// ── Copilot agent endpoint ──────────────────────────────────────────────────
// GitHub sends all agent interactions as POST /
app.post('/', handleCopilotRequest);

// ── Health probe (used by Dockerfile HEALTHCHECK + smoke tests) ─────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'java-backend-copilot-extension' });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`✅ Java Backend Copilot Extension listening on port ${PORT}`);
  console.log(`   Skills: validate_jpa_entity | next_flyway_version | check_kafka_topic | get_reference`);
});
