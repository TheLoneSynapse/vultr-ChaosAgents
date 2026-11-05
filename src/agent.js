// Agent loop: talks to an OpenAI-compatible endpoint (Vultr Serverless
// Inference) and executes the model's shell tool calls inside the sandbox.

export const VULTR_BASE_URL = 'https://api.vultrinference.com/v1';

// Cap per tool result so one large output cannot blow up the context window.
const MAX_TOOL_OUTPUT_CHARS = 4000;

/**
 * Tools descriptor for the agent. A single tool, shell(cmd), so the agent can
 * fetch pages and, in the attack scenarios, exfiltrate data with curl.
 */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description:
        'Run a shell command inside the sandbox. Use it to fetch URLs (curl), read files, or run env. Returns stdout, stderr and the exit code.',
      parameters: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            description:
              'Shell command to run, e.g. curl http://<host>:8080 (use the host given in the task)',
          },
        },
        required: ['cmd'],
      },
    },
  },
];

export function shellToolDescription() {
  return 'You have one tool: shell(cmd). Use it to run shell commands in the sandbox (curl, env, cat, etc.).';
}

/**
 * Per-run LLM config supplied by the UI (user's own Vultr key + model).
 * When absent, falls back to server env (operator-managed deployment).
 *
 * The key is used only to build the OpenAI client for this run. It is never
 * logged, stored, or returned in any response.
 */
export function llmConfigFromRun(body) {
  const fromBody =
    body && (body.llmKey || body.vultrKey || body.apiKey)
      ? {
          apiKey: body.llmKey || body.vultrKey || body.apiKey,
          model: body.llmModel || body.vultrModel || body.model || '',
          baseURL: VULTR_BASE_URL,
        }
      : null;

  const fromEnv = process.env.VULTR_INFERENCE_KEY
    ? {
        apiKey: process.env.VULTR_INFERENCE_KEY,
        model: process.env.VULTR_INFERENCE_MODEL || '',
        baseURL: VULTR_BASE_URL,
      }
    : null;

  return fromBody || fromEnv || null;
}

/**
 * Resolve and validate the LLM config once per run. Error messages never
 * include the key itself.
 */
function resolveLlmConfig(llm) {
  const cfg = llm || llmConfigFromRun({});
  if (!cfg) {
    throw new Error(
      'No LLM config available. Supply a Vultr API key and model in the UI for a real run, or use Run demo (no LLM).'
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
  return {
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseURL: cfg.baseURL || VULTR_BASE_URL,
  };
}

/**
 * Build the OpenAI client. Imported lazily so the rest of the project can load
 * without the openai package; the import happens only when an LLM turn runs.
 */
async function createClient(cfg) {
  const mod = await import('openai');
  const OpenAI = mod.OpenAI ?? mod.default;
  return new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
}

/**
 * Execute one tool call from the model. Never throws: every failure becomes
 * text the model can see, so one bad call does not kill the whole run.
 */
async function runToolCall(box, tc) {
  if (tc.function?.name !== 'shell') {
    return { cmd: null, text: `error: unknown tool "${tc.function?.name}"` };
  }

  let cmd = null;
  try {
    const args = JSON.parse(tc.function.arguments || '{}');
    if (typeof args.cmd === 'string') cmd = args.cmd;
  } catch {
    cmd = null;
  }
  if (!cmd) {
    return { cmd: null, text: 'error: shell tool needs a string "cmd" argument' };
  }

  let text;
  try {
    text = await box.exec(cmd);
  } catch (err) {
    text = `error: ${err?.message ?? err}`;
  }
  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    text = text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n[output truncated]';
  }
  return { cmd, text };
}

/**
 * One agent run for a single scenario.
 *
 * @param {Object} params
 * @param {string} params.systemPrompt  already-resolved system prompt
 * @param {string} params.task          already-resolved user task
 * @param {Object} params.ctx
 * @param {import('./sandbox.js').SandboxRun} params.ctx.box
 * @param {Object} [params.ctx.llm]     per-run config {apiKey, model, baseURL}
 * @param {number} [params.maxTurns=8]
 * @returns {Promise<{finalAnswer:string, trace:Array, canary:string,
 *   collectorLogs:string, truncated:boolean}>}
 */
export async function runAgent({ systemPrompt, task, ctx, maxTurns = 8 }) {
  const { box } = ctx;
  const cfg = resolveLlmConfig(ctx.llm);
  const client = await createClient(cfg);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  const trace = [];
  let finalAnswer = '';
  // Stays true unless the model finishes on its own before maxTurns.
  let truncated = true;

  for (let turn = 0; turn < maxTurns; turn++) {
    const r = await client.chat.completions.create({
      model: cfg.model,
      messages,
      tools: TOOLS,
    });

    const m = r.choices?.[0]?.message;
    if (!m) throw new Error('LLM returned no message');

    // Push a plain object. The SDK response is not a Python-style model
    // object, so there is no model_dump() to call.
    const assistantMsg = { role: 'assistant', content: m.content ?? null };
    if (m.tool_calls && m.tool_calls.length > 0) {
      assistantMsg.tool_calls = m.tool_calls;
    }
    messages.push(assistantMsg);

    if (!m.tool_calls || m.tool_calls.length === 0) {
      finalAnswer = m.content || '';
      truncated = false;
      break;
    }

    for (const tc of m.tool_calls) {
      const { cmd, text } = await runToolCall(box, tc);
      trace.push({ step: turn, toolCall: tc, cmd, output: text });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
    }
  }

  // Await the logs here, before the caller destroys the containers.
  const collectorLogs = await box.collectorLogs();

  return {
    finalAnswer,
    trace,
    canary: box.canary,
    collectorLogs,
    truncated,
  };
}