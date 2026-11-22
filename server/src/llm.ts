// Optional LLM client (OpenAI-compatible chat completions).
//
// The news page runs fine without any model key: every `completeInference`
// call site already has a try/catch that falls back to showing the source
// summary as-is. Only `OPENAI_API_KEY` (optionally with `LLM_BASE_URL` /
// `LLM_MODEL` for a compatible endpoint) enables the LLM整理. An
// `ANTHROPIC_API_KEY` alone is intentionally not used — there is no Anthropic
// client here — so it also falls back to the no-model path.

import { z } from "zod";

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
        return schema.parse(JSON.parse(text)) as z.infer<typeof schema>;
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
