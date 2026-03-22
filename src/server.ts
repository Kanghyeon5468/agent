import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  generateText,
  createUIMessageStream,
  createUIMessageStreamResponse,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
  generateId
} from "ai";
import { z } from "zod";
import {
  filterTravelStyleList,
  sanitizeTravelStyle
} from "./travelStyleFilter";

/**
 * Llama 3.3 fp8-fast often emits fake tool JSON as plain assistant text instead of
 * native `tool_calls`, so the AI SDK never executes tools. Llama 3.1 70B follows
 * Workers AI tool calling more reliably for this stack.
 */
const WORKERS_AI_CHAT_MODEL = "@cf/meta/llama-3.1-70b-instruct";

// Types

interface ActiveItinerary {
  id: string;
  destination: string;
  startDate: string;
  endDate: string;
  style: string;
  dayCount: number;
  itinerary: string;
  modifications: Array<{ reason: string; timestamp: string }>;
  createdAt: string;
}

interface SavedTrip {
  id: string;
  destination: string;
  startDate: string;
  endDate: string;
  style: string;
  summary: string;
  itinerary: string;
  savedAt: string;
}

interface UserMemory {
  preferredStyles: string[];
  budgetLevel: string;
  likedPlaceTypes: string[];
  dislikedPlaceTypes: string[];
  dietaryRestrictions: string[];
  pastDestinations: string[];
  notes: string[];
}

interface TripPlannerState {
  activeItinerary: ActiveItinerary | null;
  savedTrips: SavedTrip[];
  memory: UserMemory;
}

interface DestinationInfo {
  country: string;
  description: string;
  topAttractions: string[];
  bestMonths: string[];
  cuisine: string[];
  avgDailyCost: { budget: number; moderate: number; luxury: number };
  language: string;
  currency: string;
  tips: string[];
  temps: number[];
  rain: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

function cloneDefaultMemory(): UserMemory {
  return {
    preferredStyles: [],
    budgetLevel: "",
    likedPlaceTypes: [],
    dislikedPlaceTypes: [],
    dietaryRestrictions: [],
    pastDestinations: [],
    notes: []
  };
}

function defaultState(): TripPlannerState {
  return {
    activeItinerary: null,
    savedTrips: [],
    memory: cloneDefaultMemory()
  };
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];

// Curated destination database — replace with real APIs in production
const DESTINATIONS: Record<string, DestinationInfo> = {
  tokyo: {
    country: "Japan",
    description:
      "A dazzling blend of ultramodern and traditional — from neon-lit Shibuya to serene Meiji Shrine.",
    topAttractions: [
      "Senso-ji Temple",
      "Shibuya Crossing",
      "Meiji Shrine",
      "Tsukiji Outer Market",
      "Akihabara",
      "Shinjuku Gyoen",
      "Tokyo Skytree",
      "Harajuku"
    ],
    bestMonths: ["March", "April", "October", "November"],
    cuisine: [
      "Sushi",
      "Ramen",
      "Tempura",
      "Yakitori",
      "Matcha desserts",
      "Wagyu beef"
    ],
    avgDailyCost: { budget: 80, moderate: 180, luxury: 450 },
    language: "Japanese",
    currency: "JPY (¥)",
    tips: [
      "Get a Suica/Pasmo card for trains",
      "Carry cash — many places don't accept cards",
      "Bow when greeting",
      "Remove shoes before entering homes and some restaurants"
    ],
    temps: [5, 6, 10, 15, 20, 23, 27, 28, 25, 19, 13, 8],
    rain: [
      "low",
      "low",
      "moderate",
      "moderate",
      "moderate",
      "high",
      "moderate",
      "moderate",
      "high",
      "high",
      "low",
      "low"
    ]
  },
  paris: {
    country: "France",
    description:
      "The City of Light enchants with world-class art, iconic architecture, and an unrivaled culinary scene.",
    topAttractions: [
      "Eiffel Tower",
      "Louvre Museum",
      "Notre-Dame",
      "Montmartre",
      "Champs-Élysées",
      "Musée d'Orsay",
      "Le Marais",
      "Sainte-Chapelle"
    ],
    bestMonths: ["April", "May", "June", "September", "October"],
    cuisine: [
      "Croissants",
      "Coq au vin",
      "Crêpes",
      "Macarons",
      "Cheese & wine",
      "Escargot"
    ],
    avgDailyCost: { budget: 90, moderate: 200, luxury: 500 },
    language: "French",
    currency: "EUR (€)",
    tips: [
      "Learn basic French phrases",
      "Book museum tickets in advance",
      "Beware of pickpockets at tourist spots",
      "Tip is included in the bill (service compris)"
    ],
    temps: [4, 5, 9, 12, 16, 20, 22, 22, 18, 13, 8, 5],
    rain: [
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "low",
      "low",
      "low",
      "low",
      "moderate",
      "moderate",
      "moderate"
    ]
  },
  bangkok: {
    country: "Thailand",
    description:
      "A vibrant capital of golden temples, floating markets, and legendary street food.",
    topAttractions: [
      "Grand Palace",
      "Wat Pho",
      "Chatuchak Market",
      "Khao San Road",
      "Wat Arun",
      "Jim Thompson House",
      "Chinatown (Yaowarat)"
    ],
    bestMonths: ["November", "December", "January", "February"],
    cuisine: [
      "Pad Thai",
      "Tom Yum Goong",
      "Green Curry",
      "Mango Sticky Rice",
      "Som Tum",
      "Boat noodles"
    ],
    avgDailyCost: { budget: 35, moderate: 90, luxury: 280 },
    language: "Thai",
    currency: "THB (฿)",
    tips: [
      "Dress modestly at temples",
      "Negotiate tuk-tuk fares before riding",
      "Stay hydrated — it's hot year-round",
      "Never disrespect the monarchy"
    ],
    temps: [27, 28, 30, 31, 30, 29, 29, 28, 28, 28, 27, 26],
    rain: [
      "low",
      "low",
      "low",
      "moderate",
      "high",
      "high",
      "high",
      "high",
      "high",
      "high",
      "moderate",
      "low"
    ]
  },
  barcelona: {
    country: "Spain",
    description:
      "Gaudí's masterpieces, Mediterranean beaches, and a buzzing food scene make Barcelona unforgettable.",
    topAttractions: [
      "Sagrada Familia",
      "Park Güell",
      "La Rambla",
      "Gothic Quarter",
      "Casa Batlló",
      "Barceloneta Beach",
      "La Boqueria Market"
    ],
    bestMonths: ["May", "June", "September", "October"],
    cuisine: [
      "Tapas",
      "Paella",
      "Patatas bravas",
      "Churros con chocolate",
      "Jamón ibérico",
      "Cava"
    ],
    avgDailyCost: { budget: 65, moderate: 160, luxury: 400 },
    language: "Spanish / Catalan",
    currency: "EUR (€)",
    tips: [
      "Book Sagrada Familia tickets weeks ahead",
      "Siesta hours (2–5 PM) mean some shops close",
      "Watch for pickpockets on La Rambla",
      "Dinner starts at 9 PM or later"
    ],
    temps: [9, 10, 12, 14, 18, 22, 25, 25, 22, 18, 13, 10],
    rain: [
      "low",
      "low",
      "moderate",
      "moderate",
      "moderate",
      "low",
      "low",
      "low",
      "moderate",
      "moderate",
      "moderate",
      "moderate"
    ]
  },
  "new york": {
    country: "United States",
    description:
      "The city that never sleeps — world-famous skyline, Broadway, and a melting pot of cultures.",
    topAttractions: [
      "Statue of Liberty",
      "Central Park",
      "Times Square",
      "Brooklyn Bridge",
      "Metropolitan Museum",
      "Empire State Building",
      "High Line",
      "Broadway"
    ],
    bestMonths: ["April", "May", "September", "October"],
    cuisine: [
      "Pizza",
      "Bagels",
      "Pastrami sandwich",
      "Cheesecake",
      "Dim sum",
      "Food trucks"
    ],
    avgDailyCost: { budget: 100, moderate: 250, luxury: 600 },
    language: "English",
    currency: "USD ($)",
    tips: [
      "Get a MetroCard for subways",
      "Walk — it's the best way to explore",
      "Tip 18–20% at restaurants",
      "Book Broadway shows on TodayTix for discounts"
    ],
    temps: [1, 2, 7, 13, 18, 24, 27, 26, 22, 16, 10, 4],
    rain: [
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate"
    ]
  },
  rome: {
    country: "Italy",
    description:
      "The Eternal City layers ancient ruins, Renaissance art, and la dolce vita in every piazza.",
    topAttractions: [
      "Colosseum",
      "Vatican Museums",
      "Trevi Fountain",
      "Pantheon",
      "Roman Forum",
      "Spanish Steps",
      "Trastevere",
      "Borghese Gallery"
    ],
    bestMonths: ["April", "May", "September", "October"],
    cuisine: [
      "Carbonara",
      "Cacio e pepe",
      "Supplì",
      "Gelato",
      "Tiramisu",
      "Pizza al taglio"
    ],
    avgDailyCost: { budget: 70, moderate: 170, luxury: 420 },
    language: "Italian",
    currency: "EUR (€)",
    tips: [
      "Book Vatican tickets online to skip the line",
      "Free refill fountains (nasoni) are everywhere",
      "Validate train tickets before boarding",
      "Cover shoulders and knees in churches"
    ],
    temps: [8, 9, 11, 14, 18, 23, 26, 26, 22, 17, 12, 9],
    rain: [
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "low",
      "low",
      "low",
      "low",
      "moderate",
      "moderate",
      "moderate",
      "moderate"
    ]
  },
  bali: {
    country: "Indonesia",
    description:
      "Lush rice terraces, sacred temples, and world-class surf breaks on the Island of the Gods.",
    topAttractions: [
      "Ubud Rice Terraces",
      "Uluwatu Temple",
      "Tanah Lot",
      "Sacred Monkey Forest",
      "Seminyak Beach",
      "Tirta Empul",
      "Mount Batur"
    ],
    bestMonths: ["April", "May", "June", "September"],
    cuisine: [
      "Nasi Goreng",
      "Babi Guling",
      "Satay",
      "Lawar",
      "Smoothie bowls",
      "Kopi Luwak"
    ],
    avgDailyCost: { budget: 30, moderate: 80, luxury: 250 },
    language: "Indonesian / Balinese",
    currency: "IDR (Rp)",
    tips: [
      "Rent a scooter for easy travel",
      "Respect temple dress codes",
      "Bargain at markets",
      "Don't touch people's heads — it's considered rude"
    ],
    temps: [27, 27, 27, 27, 27, 26, 26, 26, 27, 27, 27, 27],
    rain: [
      "high",
      "high",
      "high",
      "moderate",
      "low",
      "low",
      "low",
      "low",
      "low",
      "moderate",
      "moderate",
      "high"
    ]
  },
  seoul: {
    country: "South Korea",
    description:
      "K-pop, kimchi, and ancient palaces — Seoul blends tradition with cutting-edge modernity.",
    topAttractions: [
      "Gyeongbokgung Palace",
      "Bukchon Hanok Village",
      "Myeongdong",
      "N Seoul Tower",
      "Hongdae",
      "Changdeokgung Secret Garden",
      "Gangnam",
      "Insadong"
    ],
    bestMonths: ["March", "April", "May", "September", "October"],
    cuisine: [
      "Korean BBQ",
      "Bibimbap",
      "Tteokbokki",
      "Kimchi jjigae",
      "Fried chicken & beer",
      "Hotteok"
    ],
    avgDailyCost: { budget: 60, moderate: 140, luxury: 350 },
    language: "Korean",
    currency: "KRW (₩)",
    tips: [
      "T-money card works on all public transport",
      "Convenience stores have great meals",
      "Download Naver Map — Google Maps is limited in Korea",
      "Bow slightly when meeting elders"
    ],
    temps: [-2, 0, 6, 13, 18, 23, 25, 26, 22, 15, 7, 0],
    rain: [
      "low",
      "low",
      "low",
      "moderate",
      "moderate",
      "high",
      "high",
      "high",
      "moderate",
      "low",
      "moderate",
      "low"
    ]
  },
  london: {
    country: "United Kingdom",
    description:
      "Royal palaces, world-class museums (many free!), and a thriving multicultural food scene.",
    topAttractions: [
      "British Museum",
      "Tower of London",
      "Buckingham Palace",
      "Westminster Abbey",
      "Camden Market",
      "South Bank",
      "Hyde Park",
      "Borough Market"
    ],
    bestMonths: ["May", "June", "July", "September"],
    cuisine: [
      "Fish & chips",
      "Sunday roast",
      "Afternoon tea",
      "Pie & mash",
      "Curry on Brick Lane",
      "Borough Market treats"
    ],
    avgDailyCost: { budget: 95, moderate: 220, luxury: 520 },
    language: "English",
    currency: "GBP (£)",
    tips: [
      "Get an Oyster card or use contactless",
      "Many museums are free",
      "Stand on the right on escalators",
      "Tipping 10–12.5% is customary at restaurants"
    ],
    temps: [5, 5, 8, 11, 14, 18, 20, 20, 17, 13, 8, 5],
    rain: [
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "moderate"
    ]
  },
  istanbul: {
    country: "Turkey",
    description:
      "Where East meets West — Byzantine mosaics, Ottoman mosques, and the legendary Grand Bazaar.",
    topAttractions: [
      "Hagia Sophia",
      "Blue Mosque",
      "Grand Bazaar",
      "Topkapi Palace",
      "Bosphorus Cruise",
      "Basilica Cistern",
      "Galata Tower",
      "Spice Bazaar"
    ],
    bestMonths: ["April", "May", "September", "October"],
    cuisine: [
      "Kebab",
      "Baklava",
      "Turkish breakfast",
      "Pide",
      "Meze",
      "Turkish tea & coffee",
      "Simit"
    ],
    avgDailyCost: { budget: 40, moderate: 100, luxury: 300 },
    language: "Turkish",
    currency: "TRY (₺)",
    tips: [
      "Bargaining is expected at the Grand Bazaar",
      "Remove shoes when entering mosques",
      "Use Istanbulkart for transport",
      "Try a traditional hammam (Turkish bath)"
    ],
    temps: [6, 6, 9, 13, 18, 23, 25, 25, 22, 17, 12, 8],
    rain: [
      "moderate",
      "moderate",
      "moderate",
      "moderate",
      "low",
      "low",
      "low",
      "low",
      "low",
      "moderate",
      "moderate",
      "moderate"
    ]
  }
};

// Helpers

function getWeather(destination: string, month: string) {
  const key = destination.toLowerCase().trim();
  const mi = MONTHS.indexOf(month.toLowerCase());
  const info = DESTINATIONS[key];

  if (!info || mi === -1) {
    return {
      destination,
      month,
      note: "Weather data unavailable. Check a weather service for accurate forecasts."
    };
  }

  const avgTemp = info.temps[mi];
  const rain = info.rain[mi];

  const conditions =
    avgTemp > 28
      ? "Hot and humid"
      : avgTemp > 22
        ? "Warm and pleasant"
        : avgTemp > 15
          ? "Mild"
          : avgTemp > 5
            ? "Cool"
            : "Cold";

  const packing =
    avgTemp > 25
      ? "Light clothing, sunscreen, sunglasses, hat"
      : avgTemp > 15
        ? "Light layers, comfortable walking shoes"
        : avgTemp > 5
          ? "Warm layers, jacket, scarf"
          : "Heavy coat, gloves, warm boots, thermal layers";

  return {
    destination,
    month,
    avgTemperatureCelsius: avgTemp,
    avgTemperatureFahrenheit: Math.round((avgTemp * 9) / 5 + 32),
    conditions,
    rainfallLevel: rain,
    packingRecommendation: packing,
    note:
      rain === "high"
        ? "Rainy season — pack an umbrella and waterproof gear."
        : rain === "low"
          ? "Dry season — great weather for outdoor activities!"
          : "Occasional rain possible — a compact umbrella is handy."
  };
}

function summarizeItinerary(it: ActiveItinerary): string {
  return `${it.destination} | ${it.startDate} → ${it.endDate} | Style: ${it.style} | ${it.dayCount} day(s) | Modified ${it.modifications.length} time(s)`;
}

function summarizeMemory(mem: UserMemory): string {
  const parts: string[] = [];
  const styles = filterTravelStyleList(mem.preferredStyles);
  if (styles.length) parts.push(`Styles: ${styles.join(", ")}`);
  if (mem.budgetLevel) parts.push(`Budget: ${mem.budgetLevel}`);
  if (mem.likedPlaceTypes.length)
    parts.push(`Likes: ${mem.likedPlaceTypes.join(", ")}`);
  if (mem.dislikedPlaceTypes.length)
    parts.push(`Dislikes: ${mem.dislikedPlaceTypes.join(", ")}`);
  if (mem.dietaryRestrictions.length)
    parts.push(`Dietary: ${mem.dietaryRestrictions.join(", ")}`);
  if (mem.pastDestinations.length)
    parts.push(`Past trips: ${mem.pastDestinations.join(", ")}`);
  if (mem.notes.length) parts.push(`Notes: ${mem.notes.join("; ")}`);
  return parts.length > 0 ? parts.join("\n") : "No memories yet.";
}

/** Some Workers AI models print `{"type":"function",...}` as plain text instead of native tool_calls. */
function parseEmbeddedFunctionCall(text: string): {
  name: string;
  args: Record<string, unknown>;
} | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.type !== "function" || typeof parsed.name !== "string")
      return null;
    const rawParams = parsed.parameters ?? parsed.arguments;
    if (typeof rawParams === "string") {
      return {
        name: parsed.name,
        args: JSON.parse(rawParams) as Record<string, unknown>
      };
    }
    if (
      rawParams &&
      typeof rawParams === "object" &&
      !Array.isArray(rawParams)
    ) {
      return { name: parsed.name, args: rawParams as Record<string, unknown> };
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeToolCallInput(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return input;
    }
  }
  return input;
}

type TripToolEntry = {
  execute?: (input: unknown) => Promise<unknown>;
};

/**
 * Show only the last call per tool name in one assistant turn.
 * The model sometimes re-invokes the same read-only tools on every step (up to
 * `stopWhen: stepCountIs(6)`), which would otherwise render N identical cards —
 * often only in remote Workers AI vs local dev.
 */
const DEDUPE_UI_LAST_ONLY_TOOL_NAMES = new Set([
  "searchDestination",
  "getWeatherForecast",
  "estimateBudget",
  "createItinerary",
  "modifyItinerary"
]);

function toolCallIdsToSkipForDuplicateStateTools(
  parts: Array<{ type: string; toolName?: string; toolCallId?: string }>
): Set<string> {
  const skip = new Set<string>();
  for (const toolName of DEDUPE_UI_LAST_ONLY_TOOL_NAMES) {
    let lastCallId: string | undefined;
    for (const p of parts) {
      if (p.type === "tool-call" && p.toolName === toolName && p.toolCallId) {
        lastCallId = p.toolCallId;
      }
    }
    if (!lastCallId) continue;
    for (const p of parts) {
      if (p.type === "tool-call" && p.toolName === toolName && p.toolCallId) {
        if (p.toolCallId !== lastCallId) skip.add(p.toolCallId);
      }
    }
  }
  return skip;
}

/** Run a tool that the model printed as JSON text and emit matching UI stream chunks. */
async function emitRecoveredToolCall(
  // UIMessageStreamWriter.write expects typed chunks; we emit the same shapes as streamText.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writer: { write: (chunk: any) => void },
  embedded: { name: string; args: Record<string, unknown> },
  tripTools: Record<string, TripToolEntry>
): Promise<void> {
  const t = tripTools[embedded.name];
  if (!t?.execute) return;

  const args = { ...embedded.args };
  if (embedded.name === "createItinerary") {
    if (typeof args.dayCount === "string")
      args.dayCount = Number(args.dayCount);
    if (
      typeof args.itinerary === "string" &&
      (args.itinerary.includes("Full itinerary as readable text") ||
        args.itinerary.length < 40)
    ) {
      args.itinerary = `Day 1–${args.dayCount}: Outline for ${args.destination}. Ask me to expand with hour-by-hour detail.`;
    }
  }
  if (embedded.name === "estimateBudget") {
    if (typeof args.days === "string") args.days = Number(args.days);
    if (typeof args.travelers === "string")
      args.travelers = Number(args.travelers);
  }

  const explainId = generateId();
  writer.write({ type: "text-start", id: explainId });
  writer.write({
    type: "text-delta",
    id: explainId,
    delta: "Running saved tools (recovered from model output)…\n\n"
  });
  writer.write({ type: "text-end", id: explainId });

  const toolCallId = generateId();
  writer.write({
    type: "tool-input-available",
    toolCallId,
    toolName: embedded.name,
    input: args,
    providerExecuted: true
  });
  try {
    const output = await t.execute(args);
    writer.write({
      type: "tool-output-available",
      toolCallId,
      output,
      providerExecuted: true
    });
  } catch (err) {
    writer.write({
      type: "tool-output-error",
      toolCallId,
      errorText: err instanceof Error ? err.message : String(err),
      providerExecuted: true
    });
  }
}

// Agent

export class ChatAgent extends AIChatAgent<Env> {
  initialState: TripPlannerState = defaultState();

  private get appState(): TripPlannerState {
    const s = this.state as TripPlannerState | null;
    if (s && Array.isArray(s.savedTrips) && s.memory) return s;
    return defaultState();
  }

  onStart() {
    const s = this.state as TripPlannerState | null;
    if (!s || !Array.isArray(s.savedTrips) || !s.memory) {
      this.setState(defaultState());
    }
  }

  // Callable methods for the client UI
  @callable()
  async getActiveItineraryForClient() {
    return this.appState.activeItinerary;
  }

  @callable()
  async getMemoryForClient() {
    return this.appState.memory;
  }

  @callable()
  async getSavedTrips() {
    return this.appState.savedTrips;
  }

  @callable()
  async resetMemoryForClient() {
    const current = this.appState;
    this.setState({
      ...current,
      memory: cloneDefaultMemory()
    });
    this.broadcast(JSON.stringify({ type: "memory-updated" }));
    return { ok: true as const };
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const state = this.appState;
    const hasActiveTrip = state.activeItinerary !== null;

    const systemPrompt = `You are Trip Planner: an adaptive travel assistant with memory. Always respond in English (itineraries, explanations, and tips), even if the user writes in another language.

TOOLS (the platform runs these for you — do NOT paste JSON like {"type":"function"...} in your message):
1) Plan: searchDestination → getWeatherForecast → write a clear day-by-day plan in your reply (this is mandatory) → createItinerary (same text as itinerary). Call estimateBudget only if the user asked for costs/budget or you are adding a short optional cost note after the written plan — never let estimateBudget be the only substantive output.
2) Adapt: getActiveItinerary → rewrite plan in reply → modifyItinerary (full updated text + reason).
3) Memory: rememberPreference when you learn likes, style, diet, etc. For type "style", save only a short real label (e.g. cultural, foodie, relaxation) — never placeholders or instructions like "not specified" or "please provide".

Itinerary text: use headings (Day 1, Day 2…), times, places, tips. Tag activities [indoor] or [outdoor] when relevant.

USER MEMORY:
${summarizeMemory(state.memory)}

ACTIVE TRIP:
${hasActiveTrip ? summarizeItinerary(state.activeItinerary!) : "None"}

${getSchedulePrompt({ date: new Date() })}

RULES:
- Never output tool-call JSON as plain text; only use real tool calls.
- Call createItinerary at most once per user request (after research tools). Do not repeat it in later steps.
- ALWAYS write the full day-by-day itinerary as normal assistant text (headings, times, places) in your reply — not only tool calls. Users must see the plan in the chat. Ending the turn with only tool cards (especially only estimateBudget) is incorrect.
- If the user gives city + duration, that is enough to plan (infer reasonable dates or ask one short question in English).
- Be specific: real venues, realistic timing.
- Keep every user-facing string in English.`;

    const prunedModelMessages = pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages"
    });

    const tripTools = {
      // Feature 1: Itinerary Generation

      searchDestination: tool({
        description:
          "Look up travel info about a destination: attractions, food, costs, tips",
        inputSchema: z.object({
          destination: z.string().describe("City or region name")
        }),
        execute: async ({ destination }) => {
          const key = destination.toLowerCase().trim();
          const info = DESTINATIONS[key];
          if (info) {
            const { temps: _t, rain: _r, ...rest } = info;
            return { found: true, destination, ...rest };
          }
          return {
            found: false,
            destination,
            note: `"${destination}" not in curated database. I can still plan using general knowledge.`,
            genericTips: [
              "Check visa requirements early",
              "Book accommodation in advance",
              "Research local customs",
              "Get travel insurance"
            ]
          };
        }
      }),

      getWeatherForecast: tool({
        description: "Get weather forecast for a destination in a given month",
        inputSchema: z.object({
          destination: z.string().describe("City name"),
          month: z.string().describe("Month name, e.g. 'March'")
        }),
        execute: async ({ destination, month }) =>
          getWeather(destination, month)
      }),

      estimateBudget: tool({
        description:
          "Optional trip cost breakdown. Call only if the user explicitly asked for budget/costs, or after you already wrote the full day-by-day itinerary in your assistant message (brief supplement). Do not use for generic trip requests where the user wants an itinerary.",
        inputSchema: z.object({
          destination: z.string().describe("City name"),
          days: z.coerce.number().describe("Trip duration in days"),
          budgetLevel: z
            .enum(["budget", "moderate", "luxury"])
            .describe("Spending tier"),
          travelers: z.coerce
            .number()
            .default(1)
            .describe("Number of travelers")
        }),
        execute: async ({ destination, days, budgetLevel, travelers }) => {
          const key = destination.toLowerCase().trim();
          const info = DESTINATIONS[key];
          const daily =
            info?.avgDailyCost[budgetLevel] ??
            (budgetLevel === "budget"
              ? 70
              : budgetLevel === "moderate"
                ? 150
                : 400);

          const accommodation = Math.round(daily * 0.4 * days);
          const food = Math.round(daily * 0.25 * days);
          const transport = Math.round(daily * 0.15 * days);
          const activities = Math.round(daily * 0.15 * days);
          const misc = Math.round(daily * 0.05 * days);
          const perPerson =
            accommodation + food + transport + activities + misc;

          return {
            destination,
            days,
            budgetLevel,
            travelers,
            dailyEstimate: daily,
            breakdown: {
              accommodation,
              food,
              localTransport: transport,
              activities,
              miscellaneous: misc,
              totalPerPerson: perPerson
            },
            grandTotal: perPerson * travelers,
            currency: "USD",
            note: "Excludes international flights and travel insurance"
          };
        }
      }),

      createItinerary: tool({
        description:
          "Save the active trip. Pass the same day-by-day itinerary text you showed the user (plain text, not JSON).",
        inputSchema: z.object({
          destination: z.string(),
          startDate: z.string().describe("YYYY-MM-DD"),
          endDate: z.string().describe("YYYY-MM-DD"),
          style: z
            .string()
            .describe(
              "One short travel style label only: adventure, relaxation, cultural, foodie, nightlife, family, romantic (not budget tiers, not placeholders)"
            ),
          dayCount: z.coerce.number().describe("Number of days"),
          itinerary: z
            .string()
            .describe(
              "Full itinerary as readable text (headings, times, places)"
            )
        }),
        execute: async ({
          destination,
          startDate,
          endDate,
          style,
          dayCount,
          itinerary
        }) => {
          const current = this.appState;
          const styleStored = sanitizeTravelStyle(style) ?? "general";
          const active: ActiveItinerary = {
            id: crypto.randomUUID(),
            destination,
            startDate,
            endDate,
            style: styleStored,
            dayCount,
            itinerary,
            modifications: [],
            createdAt: new Date().toISOString()
          };

          const memory = { ...current.memory };
          if (!memory.pastDestinations.includes(destination)) {
            memory.pastDestinations = [...memory.pastDestinations, destination];
          }
          const styleForPrefs = sanitizeTravelStyle(style);
          if (
            styleForPrefs &&
            !memory.preferredStyles.some(
              (s) => s.toLowerCase() === styleForPrefs.toLowerCase()
            )
          ) {
            memory.preferredStyles = [...memory.preferredStyles, styleForPrefs];
          }

          this.setState({
            ...current,
            activeItinerary: active,
            memory
          });
          this.broadcast(JSON.stringify({ type: "itinerary-updated" }));
          this.broadcast(JSON.stringify({ type: "memory-updated" }));
          return {
            success: true,
            itineraryId: active.id,
            dayCount
          };
        }
      }),

      //Feature 2: Adaptive Modification

      getActiveItinerary: tool({
        description:
          "Read the current active itinerary. Use this before modifying so you know what to change.",
        inputSchema: z.object({}),
        execute: async () => {
          const it = this.appState.activeItinerary;
          if (!it) return { active: false, message: "No active itinerary." };
          return { active: true, ...it };
        }
      }),

      modifyItinerary: tool({
        description:
          "Replace the active itinerary text after you adapt it (full updated text).",
        inputSchema: z.object({
          reason: z
            .string()
            .describe(
              "Why: weather, fatigue, time_constraint, preference_change, etc."
            ),
          updatedItinerary: z
            .string()
            .describe("Complete updated itinerary as readable text")
        }),
        execute: async ({ reason, updatedItinerary }) => {
          const current = this.appState;
          if (!current.activeItinerary) {
            return { success: false, message: "No active itinerary." };
          }

          const modified: ActiveItinerary = {
            ...current.activeItinerary,
            itinerary: updatedItinerary,
            modifications: [
              ...current.activeItinerary.modifications,
              { reason, timestamp: new Date().toISOString() }
            ]
          };

          this.setState({ ...current, activeItinerary: modified });
          this.broadcast(JSON.stringify({ type: "itinerary-updated" }));
          return {
            success: true,
            reason,
            totalModifications: modified.modifications.length
          };
        }
      }),

      // ── Feature 3: User Memory ──

      rememberPreference: tool({
        description:
          "Save a user preference to long-term memory. Call this proactively when you learn something about the user.",
        inputSchema: z.object({
          type: z
            .enum([
              "style",
              "budget",
              "likedPlace",
              "dislikedPlace",
              "dietary",
              "note"
            ])
            .describe("Category of preference"),
          value: z
            .string()
            .describe(
              "Short factual value; for style, a single label like cultural or foodie (never instructions or unknown)"
            )
        }),
        execute: async ({ type, value }) => {
          const current = this.appState;
          const memory = { ...current.memory };
          const v = value.trim();

          switch (type) {
            case "style": {
              const s = sanitizeTravelStyle(v);
              if (!s) {
                return {
                  success: true,
                  remembered: "style skipped (not a usable label)"
                };
              }
              if (
                !memory.preferredStyles.some(
                  (x) => x.toLowerCase() === s.toLowerCase()
                )
              ) {
                memory.preferredStyles = [...memory.preferredStyles, s];
              }
              break;
            }
            case "budget":
              memory.budgetLevel = v;
              break;
            case "likedPlace":
              if (!memory.likedPlaceTypes.includes(v))
                memory.likedPlaceTypes = [...memory.likedPlaceTypes, v];
              break;
            case "dislikedPlace":
              if (!memory.dislikedPlaceTypes.includes(v))
                memory.dislikedPlaceTypes = [...memory.dislikedPlaceTypes, v];
              break;
            case "dietary":
              if (!memory.dietaryRestrictions.includes(v))
                memory.dietaryRestrictions = [...memory.dietaryRestrictions, v];
              break;
            case "note":
              memory.notes = [...memory.notes, v];
              break;
          }

          this.setState({ ...current, memory });
          this.broadcast(JSON.stringify({ type: "memory-updated" }));
          return { success: true, remembered: `${type}: ${v}` };
        }
      }),

      getMemory: tool({
        description: "Read all stored user memory / preferences",
        inputSchema: z.object({}),
        execute: async () => this.appState.memory
      }),

      // ── Trip management ──

      saveTrip: tool({
        description:
          "Archive the active itinerary to saved trips (keeps it even after starting a new trip)",
        inputSchema: z.object({
          summary: z.string().describe("One-line summary of the trip")
        }),
        execute: async ({ summary }) => {
          const current = this.appState;
          if (!current.activeItinerary) {
            return { success: false, message: "No active itinerary." };
          }
          const it = current.activeItinerary;
          const saved: SavedTrip = {
            id: crypto.randomUUID(),
            destination: it.destination,
            startDate: it.startDate,
            endDate: it.endDate,
            style: it.style,
            summary,
            itinerary: it.itinerary,
            savedAt: new Date().toISOString()
          };
          this.setState({
            ...current,
            savedTrips: [...current.savedTrips, saved]
          });
          this.broadcast(JSON.stringify({ type: "trips-updated" }));
          return {
            success: true,
            tripId: saved.id,
            message: `Trip to ${it.destination} archived!`
          };
        }
      }),

      listSavedTrips: tool({
        description: "List all archived trip plans",
        inputSchema: z.object({}),
        execute: async () => {
          const { savedTrips } = this.appState;
          if (savedTrips.length === 0) return "No saved trips yet.";
          return savedTrips.map((t) => ({
            id: t.id,
            destination: t.destination,
            dates: `${t.startDate} → ${t.endDate}`,
            style: t.style,
            summary: t.summary
          }));
        }
      }),

      deleteSavedTrip: tool({
        description:
          "Delete a saved trip — requires user confirmation (approval)",
        inputSchema: z.object({
          tripId: z.string().describe("Trip ID to delete")
        }),
        needsApproval: async () => true,
        execute: async ({ tripId }) => {
          const current = this.appState;
          const trip = current.savedTrips.find((t) => t.id === tripId);
          if (!trip) return { success: false, message: "Trip not found." };
          this.setState({
            ...current,
            savedTrips: current.savedTrips.filter((t) => t.id !== tripId)
          });
          this.broadcast(JSON.stringify({ type: "trips-updated" }));
          return {
            success: true,
            message: `Deleted trip to ${trip.destination}.`
          };
        }
      }),

      // Utility tools

      getUserTimezone: tool({
        description:
          "Get the user's timezone from their browser for scheduling accuracy",
        inputSchema: z.object({})
      }),

      scheduleReminder: tool({
        description:
          "Schedule a trip reminder — departure alert, booking deadline, packing reminder",
        inputSchema: scheduleSchema,
        execute: async ({ when, description }) => {
          if (when.type === "no-schedule") return "Not a valid schedule input";
          const input =
            when.type === "scheduled"
              ? when.date
              : when.type === "delayed"
                ? when.delayInSeconds
                : when.type === "cron"
                  ? when.cron
                  : null;
          if (!input) return "Invalid schedule type";
          try {
            this.schedule(input, "executeTask", description);
            return `Reminder scheduled: "${description}" (${when.type}: ${input})`;
          } catch (error) {
            return `Error scheduling: ${error}`;
          }
        }
      }),

      getScheduledReminders: tool({
        description: "List all scheduled reminders",
        inputSchema: z.object({}),
        execute: async () => {
          const tasks = this.getSchedules();
          return tasks.length > 0 ? tasks : "No reminders scheduled.";
        }
      }),

      cancelReminder: tool({
        description: "Cancel a scheduled reminder by ID",
        inputSchema: z.object({
          reminderId: z.string().describe("Reminder ID to cancel")
        }),
        execute: async ({ reminderId }) => {
          try {
            this.cancelSchedule(reminderId);
            return `Reminder ${reminderId} cancelled.`;
          } catch (error) {
            return `Error: ${error}`;
          }
        }
      })
    };

    const stream = createUIMessageStream({
      originalMessages: this.messages,
      execute: async ({ writer }) => {
        writer.write({ type: "start" });

        try {
          const result = await generateText({
            model: workersai(WORKERS_AI_CHAT_MODEL),
            maxOutputTokens: 1024,
            temperature: 0.6,
            toolChoice: "auto",
            system: systemPrompt,
            messages: prunedModelMessages,
            tools: tripTools,
            stopWhen: stepCountIs(6),
            abortSignal: options?.abortSignal
          });

          const knownToolNames = new Set(Object.keys(tripTools));
          const flatContent = result.steps.flatMap((s) => s.content);
          const skipToolCallIds =
            toolCallIdsToSkipForDuplicateStateTools(flatContent);

          const emittedToolInputIds = new Set<string>();
          const emittedToolOutputIds = new Set<string>();
          let emittedAssistantTextChars = 0;

          for (const step of result.steps) {
            writer.write({ type: "start-step" });

            const parts = step.content;
            const soloTextPart =
              parts.length === 1 && parts[0].type === "text"
                ? (parts[0] as { type: "text"; text: string })
                : null;
            const soloBody = soloTextPart?.text?.trim() ?? "";
            const embedded = soloBody.startsWith("{")
              ? parseEmbeddedFunctionCall(soloBody)
              : null;
            const recovered =
              embedded &&
              knownToolNames.has(embedded.name) &&
              !step.toolCalls.some((tc) => tc.toolName === embedded.name);

            if (recovered && embedded) {
              await emitRecoveredToolCall(
                writer,
                embedded,
                tripTools as Record<string, TripToolEntry>
              );
              emittedAssistantTextChars += 80;
            } else {
              for (const part of parts) {
                if (part.type === "text" && part.text) {
                  emittedAssistantTextChars += part.text.length;
                  const tid = generateId();
                  writer.write({ type: "text-start", id: tid });
                  writer.write({
                    type: "text-delta",
                    id: tid,
                    delta: part.text
                  });
                  writer.write({ type: "text-end", id: tid });
                } else if (part.type === "tool-call") {
                  if (skipToolCallIds.has(part.toolCallId)) continue;
                  if (emittedToolInputIds.has(part.toolCallId)) continue;
                  emittedToolInputIds.add(part.toolCallId);

                  writer.write({
                    type: "tool-input-available",
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: normalizeToolCallInput(part.input),
                    providerExecuted: true
                  });
                } else if (part.type === "tool-result") {
                  if (skipToolCallIds.has(part.toolCallId)) continue;
                  if (emittedToolOutputIds.has(part.toolCallId)) continue;
                  emittedToolOutputIds.add(part.toolCallId);

                  writer.write({
                    type: "tool-output-available",
                    toolCallId: part.toolCallId,
                    output: part.output,
                    providerExecuted: true
                  });
                }
              }
            }

            writer.write({ type: "finish-step" });
          }

          const touchedItineraryThisTurn = flatContent.some(
            (p) =>
              p.type === "tool-call" &&
              (p as { toolName?: string }).toolName === "createItinerary"
          );
          const touchedModifyThisTurn = flatContent.some(
            (p) =>
              p.type === "tool-call" &&
              (p as { toolName?: string }).toolName === "modifyItinerary"
          );
          const active = this.appState.activeItinerary;
          const planText = active?.itinerary?.trim() ?? "";
          const needsPlanFallback =
            (touchedItineraryThisTurn || touchedModifyThisTurn) &&
            emittedAssistantTextChars < 400 &&
            planText.length > 0;

          if (needsPlanFallback) {
            const tid = generateId();
            const header =
              touchedModifyThisTurn && !touchedItineraryThisTurn
                ? "\n\n### Updated itinerary\n\n"
                : "\n\n### Your trip plan\n\n";
            writer.write({ type: "text-start", id: tid });
            writer.write({
              type: "text-delta",
              id: tid,
              delta: `${header}${planText}\n`
            });
            writer.write({ type: "text-end", id: tid });
          }

          writer.write({
            type: "finish",
            finishReason: result.finishReason
          });
        } catch (error) {
          const tid = generateId();
          writer.write({ type: "text-start", id: tid });
          writer.write({
            type: "text-delta",
            id: tid,
            delta: `Server error: ${error instanceof Error ? error.message : String(error)}`
          });
          writer.write({ type: "text-end", id: tid });
          writer.write({ type: "finish", finishReason: "error" });
          console.error("onChatMessage failed", error);
        }
      }
    });

    return createUIMessageStreamResponse({ stream });
  }

  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Trip reminder fired: ${description}`);
    this.broadcast(
      JSON.stringify({
        type: "trip-reminder",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
