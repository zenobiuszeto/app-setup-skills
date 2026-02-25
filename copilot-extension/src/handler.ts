import { Request, Response } from 'express';
import { verifySignature } from './verify';
import { TOOL_DEFINITIONS, executeTool } from './skills';
import type { ChatMessage, CopilotPayload, ToolCall } from './types';

/** Copilot API endpoint — agents call back here with the GitHub token */
const COPILOT_API_URL = 'https://api.githubcopilot.com/chat/completions';

/** Maximum tool-call iterations before forcing a final answer */
const MAX_ITERATIONS = 5;

// ── SSE helpers ──────────────────────────────────────────────────────────────

function sseChunk(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Stream a plain text delta to the client */
function sseText(text: string): string {
  return sseChunk({
    choices: [{ delta: { content: text }, finish_reason: null }],
  });
}

/** Required first frame — tells Copilot the assistant role has started */
function sseAck(): string {
  return sseChunk({
    choices: [{ delta: { role: 'assistant' }, finish_reason: null }],
  });
}

function sseDone(): string {
  return 'data: [DONE]\n\n';
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleCopilotRequest(req: Request, res: Response): Promise<void> {
  // 1. Extract required headers
  const keyId     = req.headers['x-github-public-key-identifier'] as string | undefined;
  const signature = req.headers['x-github-public-key-signature']  as string | undefined;
  const token     = req.headers['x-github-token']                 as string | undefined;

  if (!keyId || !signature) {
    res.status(401).json({ error: 'Missing signature headers' });
    return;
  }

  if (!token) {
    res.status(401).json({ error: 'Missing X-GitHub-Token header' });
    return;
  }

  // 2. Verify ECDSA signature
  const isValid = await verifySignature(req.body as Buffer, keyId, signature);
  if (!isValid) {
    res.status(401).json({ error: 'Invalid request signature' });
    return;
  }

  // 3. Parse payload
  let payload: CopilotPayload;
  try {
    payload = JSON.parse((req.body as Buffer).toString()) as CopilotPayload;
  } catch {
    res.status(400).json({ error: 'Invalid JSON payload' });
    return;
  }

  // 4. Start SSE stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

  // Acknowledge — must be first frame
  res.write(sseAck());

  // 5. Run agentic loop
  try {
    await agentLoop(token, payload.messages, res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[handler] Agent loop error:', err);
    res.write(sseText(`\n\n⚠️  Extension error: ${message}`));
  }

  res.write(sseDone());
  res.end();
}

// ── Agentic loop ─────────────────────────────────────────────────────────────
//
// Flow:
//   1. Send messages + tool definitions to Copilot API
//   2. If model calls a tool  → execute it, append result, repeat
//   3. If model returns text → stream it to client, done

async function agentLoop(
  token: string,
  initialMessages: ChatMessage[],
  res: Response,
): Promise<void> {
  const messages: ChatMessage[] = [...initialMessages];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const apiResponse = await fetch(COPILOT_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        stream: true,
      }),
    });

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      throw new Error(`Copilot API ${apiResponse.status}: ${errorBody}`);
    }

    // Collect streaming response, proxying text deltas to the client
    const { toolCalls, hasToolCalls } = await collectStream(apiResponse, res);

    if (!hasToolCalls) {
      // Model produced a final text answer — done
      break;
    }

    // Append the assistant's tool-call turn
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCalls,
    });

    // Execute each tool and feed results back
    for (const toolCall of toolCalls) {
      let result: string;
      try {
        const args = JSON.parse(toolCall.function.arguments) as Record<string, string>;
        console.log(`[skill] Executing: ${toolCall.function.name}`, Object.keys(args));
        result = await executeTool(toolCall.function.name, args);
      } catch (err) {
        result = `Error executing tool ${toolCall.function.name}: ${err instanceof Error ? err.message : String(err)}`;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }
    // Loop — let model process tool results and produce next response
  }
}

// ── Stream collector ─────────────────────────────────────────────────────────
//
// Reads SSE chunks from the Copilot API:
//  - Proxies content deltas directly to the client response
//  - Accumulates tool_call deltas into complete ToolCall objects

interface CollectResult {
  toolCalls: ToolCall[];
  hasToolCalls: boolean;
}

async function collectStream(
  apiResponse: globalThis.Response,
  clientRes: Response,
): Promise<CollectResult> {
  const reader = apiResponse.body!.getReader();
  const decoder = new TextDecoder();

  // Accumulate incomplete SSE lines across chunk boundaries
  let lineBuffer = '';

  // Tool call assembly: index → mutable ToolCall
  const toolCallMap = new Map<number, ToolCall>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
      };

      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue; // skip malformed chunks
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // Proxy text content deltas straight to the client
      if (choice.delta?.content) {
        clientRes.write(sseText(choice.delta.content));
      }

      // Accumulate tool_call deltas (they arrive in pieces)
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (!toolCallMap.has(tc.index)) {
            toolCallMap.set(tc.index, {
              id: tc.id ?? '',
              type: 'function',
              function: { name: tc.function?.name ?? '', arguments: '' },
            });
          }
          const existing = toolCallMap.get(tc.index)!;
          if (tc.id)                    existing.id += tc.id;
          if (tc.function?.name)        existing.function.name += tc.function.name;
          if (tc.function?.arguments)   existing.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls = [...toolCallMap.values()];
  return { toolCalls, hasToolCalls: toolCalls.length > 0 };
}
