import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import remarkBreaks from "remark-breaks";
import { Switch } from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BrainIcon,
  CaretDownIcon,
  BugIcon,
  XIcon,
  AirplaneTiltIcon,
  MapPinIcon,
  CalendarBlankIcon,
  ArrowClockwiseIcon,
  CompassIcon,
  LightningIcon,
  ClockCounterClockwiseIcon,
  BookmarkSimpleIcon
} from "@phosphor-icons/react";
import { filterTravelStyleList } from "./travelStyleFilter";
import {
  formatAssistantItineraryText,
  normalizeMessageNewlines,
  splitAssistantTitleBody
} from "./messageText";

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

function emptyUserMemory(): UserMemory {
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

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

function formatToolLabel(name: string): string {
  const map: Record<string, string> = {
    searchDestination: "Destination Search",
    getWeatherForecast: "Weather Forecast",
    estimateBudget: "Budget Estimate",
    createItinerary: "Create Itinerary",
    getActiveItinerary: "Read Itinerary",
    modifyItinerary: "Adapt Itinerary",
    rememberPreference: "Remember",
    getMemory: "Recall Memory",
    saveTrip: "Save Trip",
    listSavedTrips: "Saved Trips",
    deleteSavedTrip: "Delete Trip",
    getUserTimezone: "Timezone",
    scheduleReminder: "Schedule Reminder",
    getScheduledReminders: "Reminders",
    cancelReminder: "Cancel Reminder",
    getPreferences: "Preferences",
    updatePreferences: "Update Preferences"
  };
  return map[name] ?? name;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeToolInput(name: string, input: any): string | null {
  if (!input) return null;
  try {
    switch (name) {
      case "searchDestination":
        return `Searching for ${input.destination}...`;
      case "getWeatherForecast":
        return `Checking ${input.month} weather in ${input.destination}...`;
      case "estimateBudget":
        return `Estimating ${input.days}-day ${input.budgetLevel} budget for ${input.destination}...`;
      case "createItinerary":
        return `Saving ${input.dayCount ?? "?"}-day ${input.style} itinerary for ${input.destination} (${input.startDate} → ${input.endDate})`;
      case "modifyItinerary":
        return `Adapting itinerary — Reason: ${input.reason}`;
      case "rememberPreference":
        return `Remembering ${input.type}: "${input.value}"`;
      case "saveTrip":
        return `Saving trip: ${input.summary}`;
      case "deleteSavedTrip":
        return `Deleting trip ${input.tripId}`;
      case "scheduleReminder":
        return `Scheduling: "${input.description}"`;
      case "cancelReminder":
        return `Cancelling reminder ${input.reminderId}`;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeToolOutput(name: string, output: any): string | null {
  if (!output) return null;
  try {
    switch (name) {
      case "searchDestination":
        if (output.found)
          return `${output.destination}, ${output.country} — ${output.topAttractions?.length ?? 0} attractions, ${output.cuisine?.length ?? 0} cuisines`;
        return `${output.destination} — not in database, using general knowledge`;
      case "getWeatherForecast":
        if (output.avgTemperatureCelsius !== undefined)
          return `${output.destination} in ${output.month}: ${output.avgTemperatureCelsius}°C (${output.avgTemperatureFahrenheit}°F), ${output.conditions}, Rain: ${output.rainfallLevel}\nPacking: ${output.packingRecommendation}`;
        return output.note ?? "Weather data unavailable";
      case "estimateBudget":
        return `${output.destination} ${output.days}d ${output.budgetLevel}: $${output.dailyEstimate}/day → Total $${output.grandTotal} (${output.travelers} traveler${output.travelers > 1 ? "s" : ""})\n  Accommodation $${output.breakdown?.accommodation} · Food $${output.breakdown?.food} · Transport $${output.breakdown?.localTransport} · Activities $${output.breakdown?.activities}`;
      case "createItinerary":
        return `Itinerary saved — ${output.dayCount ?? "?"} days`;
      case "modifyItinerary":
        if (output.success)
          return `Itinerary adapted (${output.reason}) — ${output.totalModifications} total modification(s)`;
        return output.message ?? "Modification failed";
      case "rememberPreference":
        return output.remembered ? `Saved: ${output.remembered}` : "Saved";
      case "getMemory": {
        const parts: string[] = [];
        if (output.preferredStyles?.length)
          parts.push(`Styles: ${output.preferredStyles.join(", ")}`);
        if (output.budgetLevel) parts.push(`Budget: ${output.budgetLevel}`);
        if (output.likedPlaceTypes?.length)
          parts.push(`Likes: ${output.likedPlaceTypes.join(", ")}`);
        if (output.dislikedPlaceTypes?.length)
          parts.push(`Dislikes: ${output.dislikedPlaceTypes.join(", ")}`);
        if (output.dietaryRestrictions?.length)
          parts.push(`Dietary: ${output.dietaryRestrictions.join(", ")}`);
        if (output.pastDestinations?.length)
          parts.push(`Past trips: ${output.pastDestinations.join(", ")}`);
        return parts.length > 0 ? parts.join("\n") : "No memories yet";
      }
      case "getActiveItinerary":
        if (!output.active) return "No active itinerary";
        return `${output.destination} (${output.style}) — ${output.dayCount ?? "?"} days, ${output.modifications?.length ?? 0} modifications`;
      case "saveTrip":
        return output.message ?? "Trip saved";
      case "listSavedTrips":
        if (typeof output === "string") return output;
        if (Array.isArray(output))
          return output
            .map(
              (t: { destination: string; dates: string }) =>
                `${t.destination} (${t.dates})`
            )
            .join("\n");
        return "No saved trips";
      case "deleteSavedTrip":
        return output.message ?? "Deleted";
      case "scheduleReminder":
        return typeof output === "string" ? output : "Scheduled";
      case "getScheduledReminders":
        if (typeof output === "string") return output;
        if (Array.isArray(output)) return `${output.length} reminder(s)`;
        return "No reminders";
      case "cancelReminder":
        return typeof output === "string" ? output : "Cancelled";
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function ToolPartView({
  part,
  addToolApprovalResponse,
  showDebug
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
  showDebug: boolean;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  const label = formatToolLabel(toolName);

  if (part.state === "output-available") {
    const readable = describeToolOutput(toolName, part.output);
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <Text size="xs" variant="secondary" bold>
              {label}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          {readable && (
            <pre className="text-xs text-kumo-default whitespace-pre-wrap leading-relaxed">
              {readable}
            </pre>
          )}
          {showDebug && (
            <details className="mt-2">
              <summary className="text-[11px] text-kumo-subtle cursor-pointer select-none">
                Raw JSON
              </summary>
              <pre className="text-[11px] text-kumo-subtle mt-1 overflow-auto max-h-40">
                {JSON.stringify(part.output, null, 2)}
              </pre>
            </details>
          )}
        </Surface>
      </div>
    );
  }

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    const readable = describeToolInput(toolName, part.input);
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <Text size="sm" bold>
              Approval needed: {label}
            </Text>
          </div>
          {readable && (
            <p className="text-sm text-kumo-default mb-3">{readable}</p>
          )}
          {showDebug && (
            <pre className="text-[11px] text-kumo-subtle mb-3 overflow-auto max-h-32">
              {JSON.stringify(part.input, null, 2)}
            </pre>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: true });
                }
              }}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: false });
                }
              }}
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  if (
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false)
  ) {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {label}
            </Text>
            <Badge variant="secondary">Rejected</Badge>
          </div>
        </Surface>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    const readable = describeToolInput(toolName, part.input);
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-kumo-inactive animate-spin" />
            <Text size="xs" variant="secondary">
              {readable ?? `Running ${label}...`}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  return null;
}

function memoryCount(mem: UserMemory | null): number {
  if (!mem) return 0;
  return (
    filterTravelStyleList(mem.preferredStyles).length +
    (mem.budgetLevel ? 1 : 0) +
    mem.likedPlaceTypes.length +
    mem.dislikedPlaceTypes.length +
    mem.dietaryRestrictions.length +
    mem.notes.length
  );
}

const AGENT_SESSION_STORAGE_KEY = "trip-planner-agent-session";

function getOrCreateAgentSessionId(): string {
  try {
    let id = localStorage.getItem(AGENT_SESSION_STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(AGENT_SESSION_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return `session-${Math.random().toString(36).slice(2, 14)}`;
  }
}

function Chat() {
  const [agentSessionId] = useState(() => getOrCreateAgentSessionId());
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toasts = useKumoToastManager();

  const [showTripPanel, setShowTripPanel] = useState(false);
  const [activeItinerary, setActiveItinerary] =
    useState<ActiveItinerary | null>(null);
  const [savedTrips, setSavedTrips] = useState<SavedTrip[]>([]);
  const [expandedSaved, setExpandedSaved] = useState<string | null>(null);
  const [showItineraryText, setShowItineraryText] = useState(false);
  const tripPanelRef = useRef<HTMLDivElement>(null);

  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [memory, setMemory] = useState<UserMemory | null>(null);
  const memoryPanelRef = useRef<HTMLDivElement>(null);

  const refreshItineraryRef = useRef<() => void>(() => {});
  const refreshMemoryRef = useRef<() => void>(() => {});
  const refreshTripsRef = useRef<() => void>(() => {});

  const agent = useAgent({
    agent: "ChatAgent",
    name: agentSessionId,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === "trip-reminder") {
            toasts.add({
              title: "Trip Reminder",
              description: data.description,
              timeout: 0
            });
          }
          if (data.type === "itinerary-updated") {
            refreshItineraryRef.current();
          }
          if (data.type === "memory-updated") {
            refreshMemoryRef.current();
          }
          if (data.type === "trips-updated") {
            refreshTripsRef.current();
          }
        } catch {}
      },
      [toasts]
    )
  });

  const refreshItinerary = useCallback(async () => {
    try {
      const result = await agent.call("getActiveItineraryForClient", []);
      setActiveItinerary(result as ActiveItinerary | null);
    } catch {}
  }, [agent]);

  const refreshMemory = useCallback(async () => {
    try {
      const result = await agent.call("getMemoryForClient", []);
      setMemory(result as UserMemory);
    } catch {}
  }, [agent]);

  const refreshTrips = useCallback(async () => {
    try {
      const result = await agent.call("getSavedTrips", []);
      setSavedTrips(result as SavedTrip[]);
    } catch {}
  }, [agent]);

  refreshItineraryRef.current = refreshItinerary;
  refreshMemoryRef.current = refreshMemory;
  refreshTripsRef.current = refreshTrips;

  useEffect(() => {
    if (connected) {
      refreshItinerary();
      refreshMemory();
      refreshTrips();
    }
  }, [connected, refreshItinerary, refreshMemory, refreshTrips]);

  useEffect(() => {
    if (!showTripPanel && !showMemoryPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        showTripPanel &&
        tripPanelRef.current &&
        !tripPanelRef.current.contains(e.target as Node)
      ) {
        setShowTripPanel(false);
      }
      if (
        showMemoryPanel &&
        memoryPanelRef.current &&
        !memoryPanelRef.current.contains(e.target as Node)
      ) {
        setShowMemoryPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTripPanel, showMemoryPanel]);

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    onToolCall: async (event) => {
      if (
        "addToolOutput" in event &&
        event.toolCall.toolName === "getUserTimezone"
      ) {
        event.addToolOutput({
          toolCallId: event.toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
    }
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isStreaming, sendMessage]);

  const mCount = memoryCount(memory);
  const travelStyleChips = memory
    ? filterTravelStyleList(memory.preferredStyles)
    : [];

  const resetUserMemory = useCallback(async () => {
    if (
      !window.confirm(
        "Reset all user memory? This clears preferences, past trips, notes, and related fields."
      )
    ) {
      return;
    }
    try {
      await agent.call("resetMemoryForClient", []);
      setMemory(emptyUserMemory());
      await refreshMemory();
    } catch (e) {
      console.error("resetMemoryForClient:", e);
    }
  }, [agent, refreshMemory]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              <span className="mr-2">
                <AirplaneTiltIcon
                  size={22}
                  weight="duotone"
                  className="inline-block text-kumo-accent -mt-0.5"
                />
              </span>
              Trip Planner
            </h1>
            <Badge variant="secondary">
              <CompassIcon size={12} weight="bold" className="mr-1" />
              Adaptive AI
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 mr-1">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <div className="flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />

            <div className="relative" ref={tripPanelRef}>
              <Button
                variant="secondary"
                size="sm"
                icon={<MapPinIcon size={16} />}
                onClick={() => {
                  const next = !showTripPanel;
                  setShowTripPanel(next);
                  setShowMemoryPanel(false);
                  if (next) {
                    refreshItinerary();
                    refreshTrips();
                  }
                }}
              >
                {activeItinerary ? activeItinerary.destination : "No Trip"}
                {activeItinerary &&
                  activeItinerary.modifications.length > 0 && (
                    <Badge variant="primary" className="ml-1.5">
                      <LightningIcon size={10} className="mr-0.5" />
                      {activeItinerary.modifications.length}
                    </Badge>
                  )}
              </Button>

              {showTripPanel && (
                <div className="absolute right-0 top-full mt-2 w-[440px] z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-3 max-h-[70vh] overflow-y-auto">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <MapPinIcon size={16} className="text-kumo-accent" />
                        <Text size="sm" bold>
                          Active Itinerary
                        </Text>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          aria-label="Refresh"
                          icon={<ArrowClockwiseIcon size={14} />}
                          onClick={() => {
                            refreshItinerary();
                            refreshTrips();
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          aria-label="Close"
                          icon={<XIcon size={14} />}
                          onClick={() => setShowTripPanel(false)}
                        />
                      </div>
                    </div>

                    {!activeItinerary ? (
                      <div className="py-4 text-center">
                        <AirplaneTiltIcon
                          size={28}
                          weight="duotone"
                          className="mx-auto text-kumo-inactive mb-2"
                        />
                        <Text size="sm" variant="secondary">
                          No active trip
                        </Text>
                        <div className="mt-1">
                          <Text size="xs" variant="secondary">
                            Start planning to see your itinerary here
                          </Text>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="p-3 rounded-lg bg-kumo-elevated border border-kumo-line">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-semibold text-kumo-default">
                              {activeItinerary.destination}
                            </span>
                            <Badge variant="secondary">
                              {activeItinerary.style}
                            </Badge>
                            <Badge variant="secondary">
                              {activeItinerary.dayCount} days
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <CalendarBlankIcon
                              size={12}
                              className="text-kumo-subtle"
                            />
                            <span className="text-xs text-kumo-subtle">
                              {activeItinerary.startDate} →{" "}
                              {activeItinerary.endDate}
                            </span>
                          </div>
                          {activeItinerary.modifications.length > 0 && (
                            <div className="mt-2 space-y-1">
                              <div className="flex items-center gap-1">
                                <ClockCounterClockwiseIcon
                                  size={12}
                                  className="text-kumo-accent"
                                />
                                <span className="text-xs font-medium text-kumo-accent">
                                  Modifications
                                </span>
                              </div>
                              {activeItinerary.modifications.map((mod, i) => (
                                <div
                                  key={i}
                                  className="flex items-center gap-1.5 ml-4"
                                >
                                  <LightningIcon
                                    size={10}
                                    className="text-kumo-warning shrink-0"
                                  />
                                  <span className="text-xs text-kumo-subtle">
                                    {mod.reason}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() =>
                            setShowItineraryText(!showItineraryText)
                          }
                          className="w-full flex items-center justify-between p-2.5 rounded-lg border border-kumo-line hover:bg-kumo-elevated transition-colors text-left"
                        >
                          <Text size="xs" bold>
                            Full itinerary
                          </Text>
                          <CaretDownIcon
                            size={12}
                            className={`text-kumo-inactive transition-transform ${showItineraryText ? "rotate-180" : ""}`}
                          />
                        </button>
                        {showItineraryText && (
                          <pre className="p-3 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64 leading-relaxed">
                            {activeItinerary.itinerary}
                          </pre>
                        )}
                      </div>
                    )}

                    {savedTrips.length > 0 && (
                      <div className="pt-3 border-t border-kumo-line space-y-2">
                        <div className="flex items-center gap-2">
                          <BookmarkSimpleIcon
                            size={14}
                            className="text-kumo-subtle"
                          />
                          <Text size="xs" bold>
                            Saved Trips ({savedTrips.length})
                          </Text>
                        </div>
                        {savedTrips.map((trip) => (
                          <div
                            key={trip.id}
                            className="rounded-lg border border-kumo-line p-2.5"
                          >
                            <button
                              onClick={() =>
                                setExpandedSaved(
                                  expandedSaved === trip.id ? null : trip.id
                                )
                              }
                              className="w-full flex items-center justify-between text-left"
                            >
                              <div>
                                <span className="text-xs font-medium text-kumo-default">
                                  {trip.destination}
                                </span>
                                <span className="text-[11px] text-kumo-subtle ml-2">
                                  {trip.startDate} → {trip.endDate}
                                </span>
                              </div>
                              <CaretDownIcon
                                size={12}
                                className={`text-kumo-inactive transition-transform ${expandedSaved === trip.id ? "rotate-180" : ""}`}
                              />
                            </button>
                            {expandedSaved === trip.id && (
                              <div className="mt-2 text-xs text-kumo-subtle space-y-2">
                                <p>{trip.summary}</p>
                                <Badge variant="secondary">{trip.style}</Badge>
                                {trip.itinerary ? (
                                  <pre className="p-2 rounded bg-kumo-control whitespace-pre-wrap overflow-auto max-h-40 leading-relaxed text-kumo-default">
                                    {trip.itinerary}
                                  </pre>
                                ) : null}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Surface>
                </div>
              )}
            </div>

            <div className="relative" ref={memoryPanelRef}>
              <Button
                variant="secondary"
                size="sm"
                icon={<BrainIcon size={16} />}
                onClick={() => {
                  const next = !showMemoryPanel;
                  setShowMemoryPanel(next);
                  setShowTripPanel(false);
                  if (next) refreshMemory();
                }}
              >
                Memory
                {mCount > 0 && (
                  <Badge variant="primary" className="ml-1.5">
                    {mCount}
                  </Badge>
                )}
              </Button>

              {showMemoryPanel && (
                <div className="absolute right-0 top-full mt-2 w-80 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <BrainIcon size={16} className="text-purple-400" />
                        <Text size="sm" bold>
                          User Memory
                        </Text>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close"
                        icon={<XIcon size={14} />}
                        onClick={() => setShowMemoryPanel(false)}
                      />
                    </div>

                    {!memory || mCount === 0 ? (
                      <div className="py-4 text-center">
                        <BrainIcon
                          size={28}
                          className="mx-auto text-kumo-inactive mb-2"
                        />
                        <Text size="sm" variant="secondary">
                          No memories yet
                        </Text>
                        <div className="mt-1">
                          <Text size="xs" variant="secondary">
                            I'll learn your preferences as we chat
                          </Text>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {travelStyleChips.length > 0 && (
                          <MemoryRow
                            label="Travel Style"
                            values={travelStyleChips}
                          />
                        )}
                        {memory.budgetLevel && (
                          <MemoryRow
                            label="Budget"
                            values={[memory.budgetLevel]}
                          />
                        )}
                        {memory.likedPlaceTypes.length > 0 && (
                          <MemoryRow
                            label="Likes"
                            values={memory.likedPlaceTypes}
                          />
                        )}
                        {memory.dislikedPlaceTypes.length > 0 && (
                          <MemoryRow
                            label="Dislikes"
                            values={memory.dislikedPlaceTypes}
                          />
                        )}
                        {memory.dietaryRestrictions.length > 0 && (
                          <MemoryRow
                            label="Dietary"
                            values={memory.dietaryRestrictions}
                          />
                        )}
                        {memory.pastDestinations.length > 0 && (
                          <MemoryRow
                            label="Past Trips"
                            values={memory.pastDestinations}
                          />
                        )}
                        {memory.notes.length > 0 && (
                          <MemoryRow label="Notes" values={memory.notes} />
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full mt-2"
                          onClick={() => void resetUserMemory()}
                        >
                          Reset all memory
                        </Button>
                      </div>
                    )}
                  </Surface>
                </div>
              )}
            </div>

            <Button
              variant="secondary"
              size="sm"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<AirplaneTiltIcon size={32} weight="duotone" />}
              title="Adaptive Trip Planner"
              contents={
                <div className="space-y-3">
                  <div className="text-sm text-kumo-subtle text-center">
                    Plan trips, adapt on the fly, and I'll remember your style
                  </div>
                  <div className="flex flex-wrap justify-center gap-2">
                    {[
                      "Plan a 3-day Seoul trip, foodie style",
                      "It's raining, change my plan",
                      "I love street food and hate museums",
                      "What do you remember about me?"
                    ].map((prompt) => (
                      <Button
                        key={prompt}
                        variant="outline"
                        size="sm"
                        disabled={isStreaming}
                        onClick={() => {
                          sendMessage({
                            role: "user",
                            parts: [{ type: "text", text: prompt }]
                          });
                        }}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                </div>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}

                {message.parts.filter(isToolUIPart).map((part) => (
                  <ToolPartView
                    key={part.toolCallId}
                    part={part}
                    addToolApprovalResponse={addToolApprovalResponse}
                    showDebug={showDebug}
                  />
                ))}

                {message.parts
                  .filter(
                    (part) =>
                      part.type === "reasoning" &&
                      (part as { text?: string }).text?.trim()
                  )
                  .map((part, i) => {
                    const reasoning = part as {
                      type: "reasoning";
                      text: string;
                      state?: "streaming" | "done";
                    };
                    const isDone = reasoning.state === "done" || !isStreaming;
                    return (
                      <div key={i} className="flex justify-start">
                        <details className="max-w-[85%] w-full" open={!isDone}>
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                            <BrainIcon size={14} className="text-purple-400" />
                            <span className="font-medium text-kumo-default">
                              Reasoning
                            </span>
                            {isDone ? (
                              <span className="text-xs text-kumo-success">
                                Complete
                              </span>
                            ) : (
                              <span className="text-xs text-kumo-brand">
                                Thinking...
                              </span>
                            )}
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-kumo-inactive"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                            {reasoning.text}
                          </pre>
                        </details>
                      </div>
                    );
                  })}

                {isUser
                  ? message.parts
                      .filter((part) => part.type === "text")
                      .map((part, i) => {
                        const text = (part as { type: "text"; text: string })
                          .text;
                        if (!text) return null;
                        return (
                          <div key={i} className="flex justify-end">
                            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed whitespace-pre-line">
                              {normalizeMessageNewlines(text)}
                            </div>
                          </div>
                        );
                      })
                  : (() => {
                      const chunks = message.parts
                        .filter((part) => part.type === "text")
                        .map((p) => (p as { type: "text"; text: string }).text)
                        .filter(Boolean);
                      if (chunks.length === 0) return null;
                      const formatted = formatAssistantItineraryText(
                        chunks.join("\n\n")
                      );
                      const { title, body } =
                        splitAssistantTitleBody(formatted);
                      return (
                        <div className="flex justify-start">
                          <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed overflow-hidden">
                            {title ? (
                              <div className="px-4 pt-3 pb-2 text-base font-semibold text-kumo-default border-b border-kumo-line/60">
                                {title}
                              </div>
                            ) : null}
                            <Streamdown
                              className={`sd-theme assistant-streamdown rounded-2xl rounded-bl-md ${title ? "px-4 pb-3 pt-2" : "p-3"}`}
                              controls={false}
                              isAnimating={isLastAssistant && isStreaming}
                              remarkPlugins={[remarkBreaks]}
                            >
                              {title ? body : formatted}
                            </Streamdown>
                          </div>
                        </div>
                      );
                    })()}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder="Plan a trip, change conditions, or tell me your preferences..."
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function MemoryRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs font-medium text-kumo-subtle shrink-0 w-20">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {values.map((v, i) => (
          <Badge key={i} variant="secondary">
            {v}
          </Badge>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
