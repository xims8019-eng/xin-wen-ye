// Optional LLM client (OpenAI-compatible chat completions).
//
// The news page runs fine without any model key: every `completeInference`
// call site already has a try/catch that falls back to showing the source
// summary as-is. Only `OPENAI_API_KEY` (optionally with `LLM_BASE_URL` /
// `LLM_MODEL` for a compatible endpoint) enables the LLM整理. An
// `ANTHROPIC_API_KEY` alone is intentionally not used — there is no Anthropic
// client here — so it also falls back to the no-model path.

import { z } from "zod";

/**
 * Thrown when a model call fails deterministically — a JSON parse failure,
 * a schema failure after array→{items} wrapping, or an empty response.
 * The caller's enrichment loop must NOT retry these (no split-half, no
 * backoff): the batch ends at once and keeps the previous summary /
 * original text. (p-round, 2026-11-23.)
 */
export class EnrichDeterministicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrichDeterministicError";
  }
}

/** True for errors that must never be retried (see EnrichDeterministicError). */
export function isDeterministicEnrichError(e: unknown): boolean {
  if (e instanceof EnrichDeterministicError) return true;
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /zoderror|schema|validation|failed to parse|json|not configured|未配置|empty response/i.test(msg);
}

export interface Inference {
  complete<T extends z.ZodTypeAny>(
    prompt: string,
    opts: { schema: T; timeout_secs?: number },
  ): Promise<z.infer<T>>;
}

/** Returns null when no OpenAI-compatible key is configured (degraded mode). */
export function createInference(): Inference | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  return {
    async complete(prompt, { schema, timeout_secs }) {
      const controller = new AbortController();
      const timeoutMs = (timeout_secs ?? 60) * 1000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 500);
          throw new Error(`LLM request failed: HTTP ${res.status} ${detail}`);
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
        const text = data.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("LLM returned an empty response");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new EnrichDeterministicError(`LLM 返回的不是合法 JSON: ${text.slice(0, 200)}`);
        }
        // Bare top-level array tolerance (p-round, 2026-11-23): Gemini's
        // OpenAI-compat layer ignores the json_object constraint and
        // returns a bare array for the batch prompts; wrap it as
        // {"items": [...]} before validating. Only wrap for {"items": [...]}
        // schemas (the three batch calls); the single-item detail call
        // keeps its own schema and is unaffected.
        try {
          const isItemsSchema = schema instanceof z.ZodObject && "items" in schema.shape;
          if (Array.isArray(parsed) && isItemsSchema) parsed = { items: parsed };
        } catch {
          if (Array.isArray(parsed)) parsed = { items: parsed };
        }
        try {
          return schema.parse(parsed) as z.infer<typeof schema>;
        } catch (e) {
          throw new EnrichDeterministicError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Runs one structured LLM call, or throws when no model is configured so the
 * caller's existing try/catch fallback takes over.
 */
export async function completeInference<T extends z.ZodTypeAny>(
  source: { inference: Inference | null },
  prompt: string,
  opts: { schema: T; timeout_secs?: number },
): Promise<z.infer<T>> {
  if (!source.inference) {
    throw new Error("LLM 未配置：未设置 OPENAI_API_KEY，大模型整理已降级为展示原始摘要");
  }
  return source.inference.complete(prompt, opts);
}
