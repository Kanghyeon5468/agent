# Trip Planner (Cloudflare)

A small chat app that acts like a trip planner: you describe where you want to go, and the assistant researches destinations, sketches weather and budget context, and writes a **day-by-day itinerary** you can read in the thread. State (active plan, saved trips, and light “memory” for preferences) lives in a **Durable Object**, and the model runs on **Workers AI** (Llama 3.1 70B in this repo).

The assistant is asked to reply in **English only** in the UI, even if you type in another language.

---

## What you get

- **Full plans in chat** — Headings, timing, places, and practical notes; not just a tool card hidden behind the UI.
- **Structured tools** — Search-style destination context, weather, budget hints, then `createItinerary` / `modifyItinerary` so the same text is stored as the active itinerary.
- **Preferences** — Likes, style, diet, and similar details can be stored with `rememberPreference` and reused on later turns. Obvious junk (“not specified”, “please provide…”) and bare budget tier labels are filtered so the UI chips stay useful.
- **Session privacy (per browser)** — Each browser gets its own session id in `localStorage`, so two people on the same deployment are not sharing one chat by accident.
- **Readable markdown** — Literal `\n` sequences and awkward glued titles (e.g. “Your trip planDay 1”) are normalized so Streamdown renders paragraphs and day breaks cleanly.
- **Optional admin** — If you turn it on and configure KV + a secret, you can list recent chat sessions and open a transcript from a simple HTML panel at `/admin` (handy for debugging or support; keep it locked down in production).

Stack in short: **Cloudflare Worker + Durable Object**, **Workers AI**, **Vite + React 19**, **Tailwind 4**, **AI SDK** / **agents** / **@cloudflare/ai-chat**.

---

## Workflows

### Your side (using the app)

1. **Run or open** the app (local or deployed URL).
2. **Start planning** — A line like “Plan 7 days in Tokyo, budget around £500, I like slow mornings and museums” is enough. The model may ask **one short** clarifying question if something critical is missing.
3. **Iterate** — Ask to change days, swap neighborhoods, or tighten the budget; the agent is expected to pull the active itinerary, rewrite the plan in chat, then call `modifyItinerary` with the full updated text and a short reason.
4. **Let preferences stick** — When you mention travel style or constraints, they can be remembered for the rest of the session (and show up as chips where the UI surfaces memory).
5. **Reset when you want** — Clearing memory / starting fresh is supported from the client so you are not stuck with old preferences.

### What happens on each message (under the hood)

<img width="592" height="93" alt="image" src="https://github.com/user-attachments/assets/5bf67d0d-4010-42d7-a24c-8901a86a95c0" />



In plain words: your message hits the Worker, the **Durable Object** holds the conversation and tools, the **model** decides which tools to run, and the **stream** brings text and tool results back to the React UI. If admin logging is enabled, completed turns can be summarized into KV for the `/admin` API.

---

## How the agent is steered

Behavior lives mainly in `src/server.ts` (`systemPrompt` and tool descriptions). Typical patterns:

| Situation | Tools (rough order) | What “good” looks like |
| --- | --- | --- |
| **New trip** | `searchDestination` → `getWeatherForecast` → `estimateBudget` when it helps | A **full** day-by-day plan appears as normal assistant text, then **`createItinerary` once** with the **same** itinerary text. |
| **Edits** | `getActiveItinerary` | Updated plan in chat, then **`modifyItinerary`** with the full new text plus a **reason**. |
| **Preferences** | `rememberPreference` | Stable, human-readable preference lines (filtered before they become UI chips). |

Hard expectations mirrored from the prompt: no fake tool JSON pasted as chat text; **do not** call `createItinerary` in a loop for one user request; city + duration is often enough to start.

---

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Workers AI is configured with **`ai.remote: true`** in `wrangler.jsonc`. That usually plays nicely with local dev, but if Wrangler complains about your account or subdomain, check the [Workers AI remote docs](https://developers.cloudflare.com/workers-ai/configuration/remote/) and your `wrangler` login.


---

## Deploy

```bash
npm run deploy
```

This runs `vite build` and **`wrangler deploy`**. Double-check that:

- The **Durable Object** migration for `ChatAgent` is applied (see `wrangler.jsonc`).
- The **KV namespace** for `CHAT_ADMIN_LOG` is bound in production if you want logging.

Live demo: [trip-planner.rkdgus5468.workers.dev](https://trip-planner.rkdgus5468.workers.dev)

---

## Project layout

| Path | Role |
| --- | --- |
| `src/server.ts` | Worker fetch, `ChatAgent` Durable Object, system prompt, tools, optional admin HTML + KV logging |
| `src/app.tsx` | Chat UI, itinerary / saved trips, tool approval, session id, Streamdown + remark-breaks |
| `src/client.tsx` | React entry |
| `src/messageText.ts` | Newline normalization and itinerary title/body formatting for the assistant stream |
| `src/travelStyleFilter.ts` | Filters junk / tier-only “styles” before preferences hit memory UI |
| `src/adminLog.ts` / `src/adminApi.ts` | KV keys, session meta, admin JSON API |
| `public/admin.html` | Minimal admin UI (also imported as raw HTML in the Worker for `/admin`) |
| `wrangler.jsonc` | Bindings: AI, Durable Object, KV, `run_worker_first` routes for API and admin |

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run deploy` | Production build + Worker deploy |
| `npm run check` | Format check, oxlint, TypeScript |
| `npm run types` | Regenerate `env.d.ts` from Wrangler |

---

## License

MIT
