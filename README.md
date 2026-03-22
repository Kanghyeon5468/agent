# AI-powered travel planning app on Cloudflare

Chat app that plans trips with **tools**, **Durable Object state** (active itinerary, saved trips, user memory), and **Workers AI**. The assistant is instructed to behave like **Trip Planner**: adaptive, memory-aware, and **English-only** in all user-facing replies—even when the user writes in another language.

LLM: Workers AI with Llama 3.1 70B
Coordination: Cloudflare Worker plus Durable Object
Input: Chat UI
Memory: Active itinerary, saved trips, user preferences

## What the agent is told to do

Behavior is defined in `src/server.ts` (`systemPrompt` in `onChatMessage`). In short:

| Flow            | Tools (order)                                                               | Outcome                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New plan**    | `searchDestination` → `getWeatherForecast` → `estimateBudget` (when useful) | Write a **full day-by-day plan in the chat** (headings, times, places, tips), then call **`createItinerary`** once with the **same** itinerary text. |
| **Change plan** | `getActiveItinerary`                                                        | Rewrite the plan in the chat, then **`modifyItinerary`** with the full updated text plus a **reason**.                                               |
| **Preferences** | `rememberPreference`                                                        | When the user shares likes, style, diet, etc., persist them for later turns.                                                                         |

**Itinerary style:** `Day 1`, `Day 2`, …; realistic timing and venues; tag activities `[indoor]` or `[outdoor]` when it helps.

**Hard rules (mirrors the prompt):**

- Do **not** paste fake tool JSON (e.g. `{"type":"function",...}`) as assistant text—only real tool calls.
- Call **`createItinerary` at most once** per user request (after research tools); don’t spam duplicate tool steps.
- The **full itinerary must appear as normal assistant text** in the thread, not only behind tool UI—users must read the plan in chat.
- City + duration is enough to plan (infer dates or ask **one short** clarifying question, in English).
- **All user-facing strings in English.**

## Implementation notes

- **Model:** `@cf/meta/llama-3.1-70b-instruct` — chosen for more reliable Workers AI tool calling than the fp8-fast Llama 3.3 variant for this stack.
- **Chat path:** `generateText` + `createUIMessageStream` / `createUIMessageStreamResponse` so tool calls from Workers AI are usable; includes recovery when the model still emits embedded function-call JSON as text.
- **State:** Active itinerary and saved trips store **itinerary as a single string** (plus metadata). Curated destination data lives in `DESTINATIONS` in `server.ts`; unknown cities still work with generic tool output and general knowledge.
- **Scheduling:** Uses the agents schedule helpers (`getSchedulePrompt`) for reminder-style context.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

With the default Workers AI **remote** setup, Wrangler may expect a workers.dev subdomain. Toggling `ai.remote` in `wrangler.jsonc` can affect local behavior.

## Deploy

```bash
npm run deploy
```

live demo URL[https://trip-planner.rkdgus5468.workers.dev]

## Project layout

| Path             | Role                                                      |
| ---------------- | --------------------------------------------------------- |
| `src/server.ts`  | Agent, `systemPrompt`, tools, Durable Object state        |
| `src/app.tsx`    | Chat UI, itinerary / saved trips panels, tool approval UI |
| `src/client.tsx` | React entry                                               |

Stack: Cloudflare Workers, Durable Objects, `@cloudflare/ai-chat`, AI SDK (`ai`), React 19, Kumo, Tailwind CSS 4.

## Instruction
Start your conversation with "Plan" 
Example : "Plan 7 days in Tokyo, my budget is £500, and i like relaxation"
## License

MIT
