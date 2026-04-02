/**
 * Hub-managed LLM caller — calls Anthropic API on behalf of hub bots.
 *
 * Routes through the local api-router (localhost:9090) which handles OAuth
 * token swapping, or calls api.anthropic.com directly with a regular API key.
 *
 * Converts world tool schemas to Anthropic format, sends scene as user message,
 * and extracts tool_use blocks from the response.
 */

const MODEL = 'claude-haiku-4-5-20251001';

// Haiku 4.5 pricing per million tokens
const COST_PER_M_INPUT        = 1.00;
const COST_PER_M_OUTPUT       = 5.00;
const COST_PER_M_CACHE_READ   = 0.10;
const COST_PER_M_CACHE_WRITE  = 1.25;

// API router on this machine handles OAuth token swap
const API_ROUTER_URL = process.env.VILLAGE_API_ROUTER_URL || 'http://127.0.0.1:9090';

/**
 * Convert world schema tool format to Anthropic tool format.
 * World: { name, description, parameters }
 * Anthropic: { name, description, input_schema }
 */
function convertTools(tools) {
  return (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/**
 * Compute cost from Anthropic response usage.
 */
function computeCost(usage) {
  if (!usage) return 0;
  const input   = (usage.input_tokens || 0) / 1_000_000 * COST_PER_M_INPUT;
  const output  = (usage.output_tokens || 0) / 1_000_000 * COST_PER_M_OUTPUT;
  const cacheRead  = (usage.cache_read_input_tokens || 0) / 1_000_000 * COST_PER_M_CACHE_READ;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) / 1_000_000 * COST_PER_M_CACHE_WRITE;
  return input + output + cacheRead + cacheWrite;
}

/**
 * Call the LLM for a hub-managed bot.
 *
 * @param {string} botName - Bot identifier
 * @param {string} strategy - Bot's strategy text
 * @param {string} scene - Markdown scene string (user message)
 * @param {Array} tools - Tool schemas in world format {name, description, parameters}
 * @param {string} systemPrompt - World system prompt
 * @param {number} maxActions - Maximum tool calls to return
 * @returns {{ actions: Array<{tool, params}>, usage: { cost: { total } } | null }}
 */
export async function callLLM(botName, strategy, scene, tools, systemPrompt, maxActions) {
  try {
    // Build system prompt: strategy first, then world prompt
    const systemParts = [];
    if (strategy) {
      systemParts.push(`## Your Strategy\n${strategy}`);
    }
    if (systemPrompt) {
      systemParts.push(systemPrompt);
    }
    const fullSystemPrompt = systemParts.join('\n\n');

    const anthropicTools = convertTools(tools);

    const body = {
      model: MODEL,
      max_tokens: 1024,
      system: fullSystemPrompt,
      messages: [{ role: 'user', content: scene }],
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    };

    // Route through api-router which handles OAuth token swap
    const resp = await fetch(`${API_ROUTER_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.VILLAGE_IRT_TOKEN || 'hub-managed',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`${resp.status} ${errText}`);
    }

    const response = await resp.json();

    // Extract tool_use blocks
    const toolUses = (response.content || [])
      .filter(block => block.type === 'tool_use')
      .slice(0, maxActions || Infinity)
      .map(block => ({
        tool: block.name,
        params: block.input,
      }));

    const cost = computeCost(response.usage);

    return {
      actions: toolUses,
      usage: { cost: { total: cost } },
    };
  } catch (err) {
    console.error(`[village] LLM call failed for ${botName}: ${err.message}`);
    return { actions: [], usage: null };
  }
}
