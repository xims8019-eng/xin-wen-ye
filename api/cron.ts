// Vercel Serverless Function: daily refresh trigger (Vercel Cron).
//
// GET /api/cron runs `refreshAll`, the same refresh the homepage and the
// daily schedule use. When CRON_SECRET is set, the request must carry
// `Authorization: Bearer <CRON_SECRET>` — Vercel Cron sends that header
// automatically once the variable exists. Without CRON_SECRET the endpoint
// is unauthenticated, so set one in production.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Actions } from "../server/src/actions.js";
import { getCtx } from "../server/src/ctx.js";

export const maxDuration = 60;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${secret}`) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
  }
  try {
    const ctx = await getCtx();
    const result = await Actions.refreshAll.handler(ctx, {});
    sendJson(res, 200, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendJson(res, 500, { error: message });
  }
}
