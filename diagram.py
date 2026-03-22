from graphviz import Digraph

dot = Digraph("cloudflare_ai_app", format="png")
dot.attr(rankdir="LR", splines="spline", nodesep="0.8", ranksep="1.0")
dot.attr("node", shape="box", style="rounded", fontsize="16")

dot.node("UI", "React Chat UI")
dot.node("W", "Cloudflare Worker API")
dot.node(
    "DO",
    "ChatAgent Durable Object\n(state: chat, itinerary,\npreferences, saved trips)",
)
dot.node("AI", "Workers AI LLM")
dot.node("KV", "KV (CHAT_ADMIN_LOG)\nadmin session transcripts", shape="cylinder")

dot.edge("UI", "W", label="HTTP / WebSocket")
dot.edge("W", "DO", label="route request")
dot.edge("DO", "AI", label="prompt + context")
dot.edge("AI", "DO", label="response")
dot.edge("DO", "W", label="return result")
dot.edge("W", "UI", label="stream / send response")
dot.edge(
    "DO",
    "KV",
    label="optional: persist chat log\n(admin enabled + secret)",
    style="dashed",
)

dot.render("architecture_diagram", cleanup=True)
print("Saved as architecture_diagram.png")
