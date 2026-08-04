import type { BrainResponse } from "./schema";

/**
 * Top-level routing tier:
 *
 * 1. Trivial messages ("ok", "thanks") → instant canned reply, zero LLM calls
 * 2. Everything else → intent classifier (cheap LLM): chat | csv_create | csv_edit
 * 3. chat → lightweight conversational agent (cheap LLM, WITH history)
 * 4. csv_create/csv_edit → the full heavy brain
 */

export type Intent = "chat" | "csv_create" | "csv_edit";

const CHEAP_MODEL = "gemini-2.0-flash-lite";
const ROUTER_TIMEOUT_MS = 10000;
const CHAT_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Tier 1 — trivial messages, no LLM at all
// ---------------------------------------------------------------------------

const TRIVIAL_PATTERNS: RegExp[] = [
  /^(ok|okay|k|kk|fine|good|great|nice|done|yes|yep|yup|no|nope|thanks|thank you|thx|ty|awesome|perfect|sure|alright|right|understood|cool|got it|i see|hmm|haha|lol)\s*[.!]*$/i,
  /^(that'?s (fine|good|great|ok|fine)|sounds good|no problem|thank you so much|thanks a lot)\s*[.!]*$/i,
];

export function isTrivialMessage(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length > 40) return false;
  return TRIVIAL_PATTERNS.some((re) => re.test(trimmed));
}

export function trivialReply(prompt: string): BrainResponse {
  const lower = prompt.trim().toLowerCase();
  if (/^(no|nope)\b/.test(lower)) {
    return {
      products: [],
      assistantMessage:
        "No problem. Tell me what you'd like to adjust or create next.",
    };
  }
  return {
    products: [],
    assistantMessage: "Got it — let me know what you'd like next.",
  };
}

// ---------------------------------------------------------------------------
// Tier 2 — intent classifier
// ---------------------------------------------------------------------------

const ROUTER_SYSTEM_PROMPT = `Classify the user's message into exactly one intent. Reply with ONLY the intent word.

- csv_create: user wants PRODUCTS GENERATED. Any mention of product types, quantities, prices, categories, options, variants, add-ons, "list of products for X", "give me products for X", "make/generate/create N products/items". Even "add 20 more products" when nothing is loaded. Anything about building catalog data.
- csv_edit: user wants EXISTING loaded products MODIFIED: "change", "update", "set", "increase", "decrease", "remove", "fix", "rename", "make active", "add a size", short commands like "10", "active", "499". Only when products are already loaded.
- chat: ONLY pure conversation: greetings, thanks, small talk, questions about how the tool works, feedback. NEVER classify anything that mentions products, prices, categories, or CSV work as chat.`;

export async function classifyIntent(
  prompt: string,
  hasProducts: boolean,
  apiKey: string
): Promise<Intent> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CHEAP_MODEL}:generateContent?key=${apiKey}`;
  const userPart = `Message: "${prompt}"\nProducts loaded: ${hasProducts ? "yes" : "no"}\nIntent:`;
  const payload = {
    contents: [{ parts: [{ text: ROUTER_SYSTEM_PROMPT + "\n\n" + userPart }] }],
    generationConfig: { maxOutputTokens: 10, temperature: 0 },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });
    if (!res.ok) return deterministicIntent(prompt, hasProducts);
    const d = await res.json();
    const text = (d.candidates?.[0]?.content?.parts?.[0]?.text || "")
      .trim()
      .toLowerCase();
    if (text.includes("csv_edit")) return "csv_edit";
    if (text.includes("csv_create")) return "csv_create";
    if (text.includes("chat")) return "chat";
    return deterministicIntent(prompt, hasProducts);
  } catch {
    return deterministicIntent(prompt, hasProducts);
  }
}

/** Safety net: keyword-based fallback when the classifier is unreachable. */
export function deterministicIntent(prompt: string, hasProducts: boolean): Intent {
  const p = prompt.toLowerCase().trim();

  // Clear creation signals
  const createWords =
    /\b(create|generate|make|build|give me|list of|new set|add \d+|create \d+)\b/;
  if (createWords.test(p)) return "csv_create";

  if (hasProducts) {
    // Products are loaded. Only genuine tool questions / greetings go to
    // chat — "what about raising prices?" is an edit instruction, not chat.
    if (/^(hello|hi|hey|thanks|thank you|thx)\b/.test(p)) return "chat";

    // QUESTIONS about the data/tool → chat. Checked BEFORE editWords so
    // "tell me about the csv" / "what is the price" are not treated as edits.
    // Imperative edits ("update the price") don't start with these words;
    // "what about X" (edit phrasing) is excluded via the "about" guard below.
    if (
      /^(what|which|how|how many|how much|where|when|who|whose|why)\b/.test(p) &&
      /\b(is|are|was|were|does|do|did|have|has|will|can)\b/.test(p) &&
      !/\babout\b/.test(p)
    ) {
      return "chat";
    }
    if (/^(tell me|show me|show|list|describe|explain|summarize|count|detail)\b/.test(p)) {
      return "chat";
    }

    const editWords =
      /\b(fix|change|update|edit|modify|remove|delete|set|adjust|correct|repair|rename|clear|increase|decrease|add|remove all|raise|lower|price|product|item|sku|variant|option|category|csv|inventory|image|photo|picture)\b/;
    if (editWords.test(p)) return "csv_edit";

    return "csv_edit"; // default with loaded products: edit, not small talk
  }

  // Nothing loaded — only creation or chat is possible
  const productWords =
    /\b(product|item|sku|pizza|tshirt|t-shirt|car|bike|grocery|food|menu|addon|add-on|variant|option|category|price|csv)\b/;
  if (productWords.test(p)) return "csv_create";
  return "chat";
}

// ---------------------------------------------------------------------------
// Tier 3 — lightweight chat agent (has history, fast)
// ---------------------------------------------------------------------------

const CHAT_SYSTEM_PROMPT = `You are the chat assistant for "Hyperzod CSV Agent" — a tool merchants use to build Hyperzod product-import CSVs.

What the tool does:
- Turns plain-English product descriptions into a Hyperzod-compatible CSV (products, options, variants, nested add-ons)
- Lets users upload an existing CSV and edit it by chatting ("increase all prices 10%")
- Shows products in an editable grid with validation, then exports

Rules:
- Be warm, concise (2-3 sentences max). Use the conversation history for context.
- If the user starts describing products, prices, or catalog work, tell them those requests go through the catalog brain — then help them phrase it (e.g. "Just say: create 5 pizzas with sizes at ₹299").
- If they ask about capabilities, explain briefly and suggest a prompt.
- Never invent product data. Never output JSON — plain text only.`;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

async function callGeminiChat(
  systemPrompt: string,
  turns: ChatTurn[],
  apiKey: string
): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CHEAP_MODEL}:generateContent?key=${apiKey}`;
  const contents = turns.map((t) => ({
    role: t.role === "user" ? "user" : "model",
    parts: [{ text: t.content }],
  }));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.5, maxOutputTokens: 300 },
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch {
    return null;
  }
}

async function callDeepSeekChat(
  systemPrompt: string,
  turns: ChatTurn[],
  apiKey: string
): Promise<string | null> {
  const url = "https://api.deepseek.com/v1/chat/completions";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: systemPrompt },
          ...turns.map((t) => ({ role: t.role, content: t.content })),
        ],
        temperature: 0.5,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

/**
 * Lightweight chat reply. Keeps the current products untouched — the grid
 * doesn't change on small talk.
 */
export async function chatReply(
  userMessage: string,
  history: ChatTurn[],
  geminiKey: string,
  deepseekKey: string | null
): Promise<BrainResponse> {
  const turns: ChatTurn[] = [
    ...history.slice(-8),
    { role: "user", content: userMessage },
  ];

  let reply: string | null = null;
  if (geminiKey) {
    reply = await callGeminiChat(CHAT_SYSTEM_PROMPT, turns, geminiKey);
  }
  if (!reply && deepseekKey) {
    reply = await callDeepSeekChat(CHAT_SYSTEM_PROMPT, turns, deepseekKey);
  }

  return {
    products: [],
    assistantMessage:
      reply?.trim() ||
      "I'm here to help with your Hyperzod catalog. Describe products to create, or upload a CSV to edit it.",
  };
}
