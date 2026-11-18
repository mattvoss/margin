/**
 * Agent definitions for SimpleAssist.
 *
 * SimpleAssist is orchestrated by a parent ToolLoopAgent. Its tools invoke
 * smaller, single-purpose subagents:
 *
 *   orchestrator ─┬─ planning subagent   (edit mode, planner enabled)
 *                 ├─ editing subagent    (edit mode)
 *                 ├─ chat subagent       (chat mode)
 *                 └─ post-process agents (one per enabled pass)
 *
 * The subagents use the same OpenAI-compatible endpoint as the active
 * SimpleAssist model. They are intentionally tool-free: all context is
 * assembled by the existing prompt builders before the call, which keeps the
 * planner/writer/chat prompts (and their prefix-cache layout) intact.
 */
import { createOpenAI } from '@ai-sdk/openai'
import { hasToolCall, isStepCount, ToolLoopAgent, type ToolSet } from 'ai'

export interface AssistAgentEndpoint {
  model: string
  baseUrl: string
  apiKey?: string
  /**
   * Extra top-level fields merged into every chat-completions request body.
   * Used for llama.cpp cache hints (`cache_prompt`, `n_keep`, `id_slot`) and
   * for `chat_template_kwargs` when a pass disables thinking.
   */
  requestBody?: Record<string, unknown>
}

/**
 * Wrap fetch so agent requests keep the same llama.cpp-specific body fields
 * the LLMClient sends. The OpenAI provider only exposes standard options, so
 * this is the smallest way to preserve prefix-cache and thinking behaviour.
 */
function requestBodyFetch(extra: Record<string, unknown> | undefined) {
  if (!extra || Object.keys(extra).length === 0) return undefined
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let next = init
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        next = { ...init, body: JSON.stringify({ ...body, ...extra }) }
      } catch {
        // Leave non-JSON bodies untouched.
      }
    }
    return globalThis.fetch(input, next)
  }
}

export function createAssistAgentModel(endpoint: AssistAgentEndpoint) {
  if (!endpoint.model.trim()) throw new Error('The selected endpoint has no model configured.')
  const provider = createOpenAI({
    baseURL: endpoint.baseUrl,
    // Local OpenAI-compatible servers commonly do not require a key, while
    // the provider requires one to be present in its request headers.
    apiKey: endpoint.apiKey || 'lm-studio',
    name: 'margin',
    ...(endpoint.requestBody ? { fetch: requestBodyFetch(endpoint.requestBody) } : {}),
  })
  return provider.chat(endpoint.model)
}

/** Planning subagent: returns the planner JSON for one edit. */
export function createAssistPlannerAgent(input: {
  endpoint: AssistAgentEndpoint
  instructions: string
}) {
  return new ToolLoopAgent({
    model: createAssistAgentModel(input.endpoint),
    instructions: input.instructions,
    stopWhen: isStepCount(1),
    temperature: 0.3,
    maxOutputTokens: 800,
  })
}

/** Editing subagent: streams the replacement prose for one edit. */
export function createAssistEditAgent(input: {
  endpoint: AssistAgentEndpoint
  instructions: string
  maxOutputTokens?: number | null
}) {
  return new ToolLoopAgent({
    model: createAssistAgentModel(input.endpoint),
    instructions: input.instructions,
    stopWhen: isStepCount(1),
    temperature: 0.7,
    ...(input.maxOutputTokens != null ? { maxOutputTokens: input.maxOutputTokens } : {}),
  })
}

/** Chat subagent: streams a chat reply for the current conversation. */
export function createAssistChatAgent(input: {
  endpoint: AssistAgentEndpoint
  instructions: string
  maxOutputTokens?: number | null
}) {
  return new ToolLoopAgent({
    model: createAssistAgentModel(input.endpoint),
    instructions: input.instructions,
    stopWhen: isStepCount(1),
    temperature: 0.7,
    ...(input.maxOutputTokens != null ? { maxOutputTokens: input.maxOutputTokens } : {}),
  })
}

/** One post-processing pass, run as its own subagent. */
export function createAssistPostProcessAgent(input: {
  endpoint: AssistAgentEndpoint
  instructions: string
  temperature: number
  maxOutputTokens?: number | null
  disableThinking?: boolean
}) {
  const requestBody = {
    ...(input.endpoint.requestBody ?? {}),
    ...(input.disableThinking
      ? { chat_template_kwargs: { enable_thinking: false } }
      : {}),
  }
  return new ToolLoopAgent({
    model: createAssistAgentModel({ ...input.endpoint, requestBody }),
    instructions: input.instructions,
    stopWhen: isStepCount(1),
    temperature: input.temperature,
    ...(input.maxOutputTokens != null ? { maxOutputTokens: input.maxOutputTokens } : {}),
  })
}

/**
 * Parent orchestrator. It never writes user-facing prose itself; it only
 * dispatches the subagents above through its tools.
 */
export function createAssistOrchestratorAgent(input: {
  endpoint: AssistAgentEndpoint
  instructions: string
  tools: ToolSet
}) {
  // `ToolSet` erases the per-tool context shape, so the settings type asks for
  // `toolsContext` even though these tools have none. The orchestrator is only
  // used for dispatch, and the cast keeps callers from having to spell out the
  // exact tool map.
  return new ToolLoopAgent({
    model: createAssistAgentModel(input.endpoint),
    instructions: input.instructions,
    tools: input.tools,
    stopWhen: [hasToolCall('finish'), isStepCount(8)],
    temperature: 0.2,
    maxOutputTokens: 512,
  } as never)
}
