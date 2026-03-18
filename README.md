# AI Trip Planner

An AI-powered travel planning assistant built on Cloudflare Workers, powered by the [Agents SDK](https://developers.cloudflare.com/agents/) and Llama 3.3.

Plan trips through natural conversation — get destination info, weather forecasts, budget estimates, day-by-day itineraries, and trip reminders, all with persistent memory across sessions.

## Architecture

This project demonstrates all four components of a Cloudflare AI application:

| Component | Implementation |
|---|---|
| **LLM** | Llama 3.3 70B on Workers AI |
| **Workflow / Coordination** | Durable Objects for multi-step trip planning pipeline + task scheduling |
| **User Input** | Real-time chat UI via Cloudflare Pages + WebSocket |
| **Memory / State** | Persistent trip plans & user preferences via Durable Object state + SQLite message history |

## Features

- **Destination Search** — curated database of 10 popular destinations with attractions, food, costs, and local tips
- **Weather Forecasts** — monthly climate data to help pick the best travel dates
- **Budget Estimation** — detailed cost breakdowns by spending tier (budget / moderate / luxury)
- **Itinerary Generation** — AI-crafted day-by-day plans tailored to your interests
- **Trip Persistence** — save, list, and delete trip plans stored in Durable Object state
- **Travel Preferences** — remembers your interests, budget level, travel style, and dietary restrictions
- **Smart Scheduling** — set departure reminders, booking deadlines, and packing alerts
- **Three Tool Patterns** — server-side auto-execute, client-side (browser timezone), and human-in-the-loop approval (trip deletion)
- **Real-time UI** — WebSocket chat with streaming responses, dark/light mode, and debug inspector

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) to start planning.

### Example prompts

- **"Plan a 5-day trip to Tokyo"** — full planning pipeline with destination search, weather, budget, and itinerary
- **"Best time to visit Barcelona?"** — weather and seasonal recommendations
- **"Show my saved trips"** — list persisted trip plans
- **"Set my preferences: I love food and culture, moderate budget"** — update travel profile
- **"Remind me to book flights in 2 days"** — scheduling

## Project Structure

```
src/
  server.ts    # Trip planner agent — tools, state management, scheduling
  app.tsx      # Chat UI with saved trips panel
  client.tsx   # React entry point
  styles.css   # Tailwind + Kumo styles
```

## Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects
- **AI Model**: Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) via Workers AI
- **Framework**: [Agents SDK](https://developers.cloudflare.com/agents/) + [AI SDK](https://sdk.vercel.ai/)
- **Frontend**: React 19 + [Kumo](https://kumo.cloudflare.com/) design system + Tailwind CSS 4
- **State**: Durable Object state (trips & preferences) + SQLite (chat history)

## Deploy

```bash
npm run deploy
```

Your trip planner goes live on Cloudflare's global network. Messages persist in SQLite, streams resume on disconnect, and the agent hibernates when idle.

## License

MIT
