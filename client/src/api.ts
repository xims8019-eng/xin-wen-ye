// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. `api` is a Proxy: calling `api.<actionName>(args)` POSTs
// `{action, args}` to `/api/action` and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime. With `verbatimModuleSyntax: true`, dropping
// `type` is a compile error.
//
// The client type keeps each action's definition alongside its call
// signature, so the existing usage keeps compiling:
//
//     import { api, type ApiResponse } from "./api";
//     type Article = ApiResponse<typeof api, "getCategoryNews">["items"][number];

import type { Actions } from "../../server/src/actions";
import type { z } from "zod";

export type ApiRequest<TApi extends ActionDefs, K extends keyof TApi> = z.infer<TApi[K]["request"]>;
export type ApiResponse<TApi extends ActionDefs, K extends keyof TApi> = z.infer<TApi[K]["response"]>;

type ActionDefs = Record<string, { request: z.ZodTypeAny; response: z.ZodTypeAny }>;

type ActionClient<TApi extends ActionDefs> = {
  [K in keyof TApi]: TApi[K] &
    ((args: ApiRequest<TApi, K>) => Promise<ApiResponse<TApi, K>>);
};

async function callAction(action: string, args: unknown): Promise<unknown> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data?.error === "string") detail = `: ${data.error}`;
    } catch {
      // Keep the status-only message below.
    }
    throw new Error(`请求 ${action} 失败（HTTP ${res.status}）${detail}`);
  }
  return (await res.json()) as unknown;
}

export const api = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    if (typeof prop !== "string") return undefined;
    return (args: unknown) => callAction(prop, args ?? {});
  },
}) as ActionClient<typeof Actions>;
