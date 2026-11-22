// Vercel Serverless Function: single RPC endpoint for all actions.
//
// The client POSTs `{action, args}`; the matching `Actions[action]` handler
// runs with the shared server context and its result is returned as JSON.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { Actions } from "../server/src/actions.js";
import type { Ctx } from "../server/src/ctx.js";
import { getCtx } from "../server/src/ctx.js";

export const maxDuration = 60;

type ActionDef = {
  request: z.ZodTypeAny;
  handler: (ctx: Ctx, args: unknown) => Promise<unknown>;
};

const actionsByName = Actions as unknown as Record<string, ActionDef | undefined>;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }
  try {
    const body = (await readJsonBody(req)) as { action?: unknown; args?: unknown };
    const name = typeof body?.action === "string" ? body.action : "";
    const def = actionsByName[name];
    if (!def) {
      sendJson(res, 404, { error: `Unknown action: ${name}` });
      return;
    }
    const ctx = await getCtx();
    // Parses (and applies defaults for) the action's request schema.
    const args = def.request.parse(body.args ?? {});
    const result = await def.handler(ctx, args);
    sendJson(res, 200, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendJson(res, 500, { error: message });
  }
}
