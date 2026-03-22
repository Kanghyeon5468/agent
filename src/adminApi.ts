import type { AdminSessionMeta } from "./adminLog";
import { FULL_PREFIX, META_PREFIX } from "./adminLog";

export function isAdminPanelEnabled(env: { ADMIN_ENABLED?: string }): boolean {
  return env.ADMIN_ENABLED === "true";
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers
    },
    status: init.status,
    statusText: init.statusText
  });
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, { status: 401 });
}

function checkSecret(
  request: Request,
  env: { ADMIN_API_SECRET?: string }
): boolean {
  const expected = env.ADMIN_API_SECRET?.trim();
  if (!expected) return false;
  const url = new URL(request.url);
  const q = url.searchParams.get("key");
  const auth = request.headers.get("Authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const candidate = q || bearer;
  return candidate.length > 0 && candidate === expected;
}

export async function handleAdminApi(
  request: Request,
  env: {
    CHAT_ADMIN_LOG?: KVNamespace;
    ADMIN_API_SECRET?: string;
    ADMIN_ENABLED?: string;
  }
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isAdminPanelEnabled(env)) {
    return new Response("Not found", { status: 404 });
  }
  const kv = env.CHAT_ADMIN_LOG;
  if (!kv || !env.ADMIN_API_SECRET?.trim()) {
    return json(
      { error: "Admin misconfigured: missing KV or ADMIN_API_SECRET." },
      { status: 503 }
    );
  }
  if (!checkSecret(request, env)) {
    return unauthorized();
  }

  if (url.pathname === "/api/admin/sessions" && request.method === "GET") {
    const listed = await kv.list({ prefix: META_PREFIX });
    const metas: AdminSessionMeta[] = [];
    for (const k of listed.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        metas.push(JSON.parse(raw) as AdminSessionMeta);
      } catch {}
    }
    metas.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    return json({ sessions: metas });
  }

  const detailMatch = url.pathname.match(/^\/api\/admin\/sessions\/([^/]+)$/);
  if (detailMatch && request.method === "GET") {
    const sessionId = detailMatch[1];
    const raw = await kv.get(`${FULL_PREFIX}${sessionId}`);
    if (!raw) {
      return json({ error: "Session not found" }, { status: 404 });
    }
    try {
      return json(JSON.parse(raw));
    } catch {
      return json({ error: "Corrupt session data" }, { status: 500 });
    }
  }

  return null;
}
