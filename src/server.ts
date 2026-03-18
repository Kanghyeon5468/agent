import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────────

interface Activity {
  time: string;
  title: string;
  description: string;
  type: string;
  location: string;
  duration: string;
  indoor: boolean;
}

interface DayPlan {
  day: number;
  date: string;
  theme: string;
  activities: Activity[];
}

interface ActiveItinerary {
  id: string;
  destination: string;
  startDate: string;
  endDate: string;
  style: string;
  days: DayPlan[];
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
  days: DayPlan[];
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

const DEFAULT_MEMORY: UserMemory = {
  preferredStyles: [],
  budgetLevel: "",
  likedPlaceTypes: [],
  dislikedPlaceTypes: [],
  dietaryRestrictions: [],
  pastDestinations: [],
  notes: []
};

function defaultState(): TripPlannerState {
  return {
    activeItinerary: null,
    savedTrips: [],
    memory: { ...DEFAULT_MEMORY }
  };
}

// Reusable zod schemas for tool inputs
const activitySchema = z.object({
  time: z.string().describe("Time in HH:MM format, e.g. '09:00'"),
  title: z.string().describe("Activity name"),
  description: z.string().describe("Brief description with insider tips"),
  type: z
    .string()
    .describe(
      "Category: sightseeing, food, shopping, nature, museum, nightlife, relaxation, transport"
    ),
  location: z.string().describe("Specific place name"),
  duration: z.string().describe("e.g. '2 hours', '30 minutes'"),
  indoor: z.boolean().describe("true = indoor activity, false = outdoor")
});

const dayPlanSchema = z.object({
  day: z.number().describe("Day number starting from 1"),
  date: z.string().describe("Date in YYYY-MM-DD format"),
  theme: z
    .string()
    .describe("Day theme, e.g. 'Historic Seoul', 'Street Food Adventure'"),
  activities: z.array(activitySchema)
});

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

// ── Helpers ──────────────────────────────────────────────────────────────

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
  return `${it.destination} | ${it.startDate} → ${it.endDate} | Style: ${it.style} | ${it.days.length} day(s) | Modified ${it.modifications.length} time(s)`;
}

function summarizeMemory(mem: UserMemory): string {
  const parts: string[] = [];
  if (mem.preferredStyles.length)
    parts.push(`Styles: ${mem.preferredStyles.join(", ")}`);
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

// ── Agent ────────────────────────────────────────────────────────────────

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

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const state = this.appState;
    const hasActiveTrip = state.activeItinerary !== null;

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: `You are "Trip Planner", an adaptive AI travel assistant with persistent memory.

## YOUR 3 CORE ABILITIES

### 1. ITINERARY GENERATION
When user requests a trip plan:
- Use searchDestination to research the destination
- Use getWeatherForecast to check weather for their travel month
- Use estimateBudget if budget is relevant
- Generate a detailed day-by-day itinerary with specific times, places, and tips
- ALWAYS call createItinerary to save it as the active trip
- Apply remembered preferences from user memory below

### 2. ADAPTIVE MODIFICATION
When user reports changed conditions, modify the active itinerary:
- "Rain / bad weather" → Replace OUTDOOR activities (indoor=false) with INDOOR alternatives
- "Tired / fatigue" → Replace active sightseeing with relaxed activities (cafés, spas, slow walks)
- "Short on time" → Consolidate activities, remove lower-priority items, tighten schedule
- "Preference change" → Swap activities to match (e.g. "more food" → add restaurant stops)
Steps: call getActiveItinerary → analyze which days/activities need changes → call modifyItinerary with only the changed days
Always explain what changed and why.

### 3. USER MEMORY
Proactively learn and remember user preferences:
- When user mentions likes → call rememberPreference (type: "likedPlace", value: "museums")
- When user's travel style is apparent → save it (type: "style", value: "foodie")
- When dietary/physical constraints mentioned → save them
- ALWAYS check memory below before generating new itineraries and apply preferences

## USER MEMORY
${summarizeMemory(state.memory)}

## ACTIVE ITINERARY
${hasActiveTrip ? summarizeItinerary(state.activeItinerary!) : "None — no active trip yet."}

${getSchedulePrompt({ date: new Date() })}

## RULES
- Respond in the same language the user writes in
- Be specific: use real place names, realistic times, practical tips
- When modifying, only pass the CHANGED days to modifyItinerary (unchanged days are kept automatically)
- After creating/modifying an itinerary, always present it nicely formatted to the user
- Proactively call rememberPreference when you learn something about the user`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        // ── Feature 1: Itinerary Generation ──

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
          description: "Calculate estimated trip budget breakdown",
          inputSchema: z.object({
            destination: z.string().describe("City name"),
            days: z.number().describe("Trip duration in days"),
            budgetLevel: z
              .enum(["budget", "moderate", "luxury"])
              .describe("Spending tier"),
            travelers: z
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
            "Create a new day-by-day itinerary and set it as the active trip. ALWAYS call this after generating an itinerary.",
          inputSchema: z.object({
            destination: z.string(),
            startDate: z.string().describe("YYYY-MM-DD"),
            endDate: z.string().describe("YYYY-MM-DD"),
            style: z
              .string()
              .describe(
                "Travel style: adventure, relaxation, cultural, foodie, nightlife, family, romantic"
              ),
            days: z.array(dayPlanSchema)
          }),
          execute: async ({ destination, startDate, endDate, style, days }) => {
            const current = this.appState;
            const itinerary: ActiveItinerary = {
              id: crypto.randomUUID(),
              destination,
              startDate,
              endDate,
              style,
              days,
              modifications: [],
              createdAt: new Date().toISOString()
            };

            // Also auto-learn from this creation
            const memory = { ...current.memory };
            if (!memory.pastDestinations.includes(destination)) {
              memory.pastDestinations = [
                ...memory.pastDestinations,
                destination
              ];
            }
            if (style && !memory.preferredStyles.includes(style)) {
              memory.preferredStyles = [...memory.preferredStyles, style];
            }

            this.setState({
              ...current,
              activeItinerary: itinerary,
              memory
            });
            this.broadcast(JSON.stringify({ type: "itinerary-updated" }));
            this.broadcast(JSON.stringify({ type: "memory-updated" }));
            return {
              success: true,
              itineraryId: itinerary.id,
              totalDays: days.length,
              totalActivities: days.reduce(
                (sum, d) => sum + d.activities.length,
                0
              )
            };
          }
        }),

        // ── Feature 2: Adaptive Modification ──

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
            "Modify the active itinerary. Only pass the days that changed — unchanged days are preserved automatically.",
          inputSchema: z.object({
            reason: z
              .string()
              .describe(
                "Why: weather, fatigue, time_constraint, preference_change, etc."
              ),
            dayUpdates: z
              .array(dayPlanSchema)
              .describe("Only the day(s) that were modified")
          }),
          execute: async ({ reason, dayUpdates }) => {
            const current = this.appState;
            if (!current.activeItinerary) {
              return { success: false, message: "No active itinerary." };
            }

            // Merge: replace only the specified days, keep the rest
            const updatedDays = [...current.activeItinerary.days];
            for (const update of dayUpdates) {
              const idx = updatedDays.findIndex((d) => d.day === update.day);
              if (idx !== -1) {
                updatedDays[idx] = update;
              }
            }

            const modified: ActiveItinerary = {
              ...current.activeItinerary,
              days: updatedDays,
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
              daysModified: dayUpdates.map((d) => d.day),
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
            value: z.string().describe("The preference value to remember")
          }),
          execute: async ({ type, value }) => {
            const current = this.appState;
            const memory = { ...current.memory };
            const v = value.trim();

            switch (type) {
              case "style":
                if (!memory.preferredStyles.includes(v))
                  memory.preferredStyles = [...memory.preferredStyles, v];
                break;
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
                  memory.dietaryRestrictions = [
                    ...memory.dietaryRestrictions,
                    v
                  ];
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
              days: it.days,
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
              summary: t.summary,
              dayCount: t.days.length
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

        // ── Utility tools ──

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
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
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
