import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";

export const META_PREFIX = "alog:meta:";
export const FULL_PREFIX = "alog:full:";
const MAX_TEXT_LEN = 16_000;
const MAX_STORED_MESSAGES = 120;

export type AdminLogEntry = {
  id: string;
  role: string;
  text?: string;
  tools?: Array<{ name: string; state?: string }>;
};

export type AdminSessionMeta = {
  sessionId: string;
  updatedAt: string;
  messageCount: number;
  lastUserPreview: string;
  lastAssistantPreview: string;
};

export type AdminSessionFull = AdminSessionMeta & {
  entries: AdminLogEntry[];
};

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function textFromParts(message: UIMessage): string {
  const parts = message.parts ?? [];
  let out = "";
  for (const p of parts) {
    if (p.type === "text" && "text" in p && p.text) out += p.text;
  }
  return out.trim();
}

function toolsFromParts(message: UIMessage): AdminLogEntry["tools"] {
  const parts = message.parts ?? [];
  const tools: NonNullable<AdminLogEntry["tools"]> = [];
  for (const p of parts) {
    if (!isToolUIPart(p)) continue;
    const name = getToolName(p);
    const state = "state" in p ? String(p.state) : undefined;
    tools.push({ name, state });
  }
  return tools.length ? tools : undefined;
}

export function uiMessagesToAdminEntries(
  messages: UIMessage[]
): AdminLogEntry[] {
  const slice = messages.slice(-MAX_STORED_MESSAGES);
  return slice.map((m) => ({
    id: m.id,
    role: m.role,
    text: (() => {
      const t = textFromParts(m);
      return t ? cap(t, MAX_TEXT_LEN) : undefined;
    })(),
    tools: toolsFromParts(m)
  }));
}

export function buildSessionMeta(
  sessionId: string,
  entries: AdminLogEntry[]
): AdminSessionMeta {
  let lastUserPreview = "";
  let lastAssistantPreview = "";
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!lastUserPreview && e.role === "user" && e.text) {
      lastUserPreview = cap(e.text, 160);
    }
    if (!lastAssistantPreview && e.role === "assistant" && e.text) {
      lastAssistantPreview = cap(e.text, 160);
    }
    if (lastUserPreview && lastAssistantPreview) break;
  }
  return {
    sessionId,
    updatedAt: new Date().toISOString(),
    messageCount: entries.length,
    lastUserPreview,
    lastAssistantPreview
  };
}

export async function persistChatSessionToKv(
  kv: KVNamespace,
  sessionId: string,
  messages: UIMessage[]
): Promise<void> {
  const entries = uiMessagesToAdminEntries(messages);
  const meta = buildSessionMeta(sessionId, entries);
  const full: AdminSessionFull = { ...meta, entries };
  await kv.put(`${META_PREFIX}${sessionId}`, JSON.stringify(meta));
  await kv.put(`${FULL_PREFIX}${sessionId}`, JSON.stringify(full));
}

export function metaKey(sessionId: string): string {
  return `${META_PREFIX}${sessionId}`;
}

export function fullKey(sessionId: string): string {
  return `${FULL_PREFIX}${sessionId}`;
}
