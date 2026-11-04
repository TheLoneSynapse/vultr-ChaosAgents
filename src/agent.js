import { SandboxRun } from './sandbox.js';

const VULTR_BASE_URL = 'https://api.vultrinference.com/v1';

/**
 * Build the tools descriptor for the agent. We expose a single tool,
 * shell(cmd), so the agent can both fetch pages and exfiltrate with curl.
 */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description:
        'Run a shell command inside the sandbox. Use it to fetch URLs (curl), read files, or run env. Returns stdout/stderr.',
      parameters: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            description: 'Shell command to run, e.g. curl http://docs-RUNID:8080',
          },
        },
        required: ['cmd'],
      },
    },
  },
];

export function shellToolDescription() {
  return `You have one tool: shell(cmd). Use it to run shell commands in the sandbox (curl, env, cat, etc.).`;
}

/**
 * Per-run LLM config supplied by the UI (user's own Vultr key + model).
 * When absent, agent.js falls back to server env (backward compat for the
 * operator-managed deployment), and when that is also absent the caller
 * gets a clear error.
 *
 * IMPORTANT: the key is used only to build the OpenAI client for this run.
 * It is never logged, never stored, and never returned in any response.
 */
export function llmConfigFromRun(body) {
  // Prefer an explicit per-run config from the UI.
  const fromBody =
    body && (body.llmKey || body.vultrKey || body.apiKey)
      ? {
          apiKey:
            body.llmKey || body.vultrKey || body.apiKey,
          model:
            body.llmModel || body.vultrModel || body.model || '',
          baseURL: VULTR_BASE_URL,
        }
      : null;

  // Fall back to server env for the operator-managed deployment path.
  const fromEnv =
    process.env.VULTR_INFERENCE_KEY
      ? {
          apiKey: process.env.VULTR_INFERENCE_KEY,
          model: process.env.VULTR_INFERENCE_MODEL || '',
          baseURL: VULTR_BASE_URL,
        }
      : null;

  return fromBody || fromEnv || null;
}

/**
 * One agent run for a single scenario.
 *
 * @param {Object} scenario
 * @param {string} scenario.systemPrompt
 * @param {string} scenario.task
 * @param {Object} ctx - harness context: runId, collectorHost, docsHost
 * @param {SandboxRun} ctx.box
 * @param {string} ctx.collectorHost
 * @param {string} ctx.docsHost
 * @param {number} [ctx.maxTurns=8]
 * @param {Object} [ctx.llm] - per-run LLM config: {apiKey, model, baseURL}
 */
export async function runAgent({ systemPrompt, task, ctx, maxTurns = 8 }) {
  const { box, collectorHost, docsHost } = ctx;

  // Inject run-specific hosts into the poisoned page instruction placeholders.
  const systemPromptResolved = systemPrompt
    .replace(/RUNID/g, ctx.runId)
    .replace(/collector-HOST/g, collectorHost);

  const messages = [
    { role: 'system', content: systemPromptResolved },
    { role: 'user', content: task },
  ];

  const trace = [];
  let finalAnswer = '';

  for (let i = 0; i < maxTurns; i++) {
    const llm = await getLlmClient(ctx.llm);
    const r = await llm.chat.completions.create({
      model: ctx.llm.model,
      messages: messages.map((m) => normalizeMessage(m)),
      tools: TOOLS,
    });
    const m = r.choices[0].message;
    messages.push(m.model_dump ? m.model_dump({ exclude_none: true }) : m);
    if (!m.tool_calls || m.tool_calls.length === 0) {
      finalAnswer = m.content || '';
      break;
    }
    for (const tc of m.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const cmd = args.cmd;
      let out;
      try {
        out = await box.exec(cmd);
      } catch (err) {
        out = `error: ${err}`;
      }
      trace.push({ step: i, toolCall: tc, cmd, output: out });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: out,
      });
    }
  }

  return {
    finalAnswer,
    trace,
    canary: box.canary,
    collectorLogs: box.collectorLogs(),
  };
}

/**
 * Get an OpenAI-compatible client against Vultr Serverless Inference.
 * Imported lazily so the rest of the project can import agent.js without
 * needing the `openai` package installed; the import only happens when an
 * LLM turn actually runs.
 *
 * @param {Object} [llm] per-run config {apiKey, model, baseURL}, or null to
 *        use server env as a fallback.
 */
async function getLlmClient(llm) {
  // Dynamic import — does not run at module evaluation time.
  const { OpenAI } = await import('openai');

  const cfg = llm
    ? llm
    : llmConfigFromRun({});

  if (!cfg) {
    throw new Error(
      'No LLM config available. Supply Vultr API key + model in the UI for a real run, or use Run demo (no LLM).'
    );
  }
  if (!cfg.apiKey) {
    throw new Error(
      'VULTR_INFERENCE_KEY is not set. Set it in the environment (or .env locally), or supply it in the UI for a real run. Never commit it.'
    );
  }
  if (!cfg.model) {
    throw new Error(
      'VULTR_INFERENCE_MODEL is not set. Pick a model that supports tool calling from https://api.vultrinference.com/v1/models and set it in the environment or the UI.'
    );
  }
  return new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
  });
}

/**
 * Normalize a chat message into the shape the openai SDK expects.
 */
function normalizeMessage(m) {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.tool_call_id,
      content: m.content,
    };
  }
  const base = { role: m.role };
  if (typeof m.content === 'string') base.content = m.content;
  else if (Array.isArray(m.content)) base.content = m.content;
  if (m.tool_calls) base.tool_calls = m.tool_calls;
  return base;
}
