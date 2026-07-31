import { NextResponse } from "next/server";
import {
  BrainRequestSchema,
  type BrainResponse,
  type Product,
} from "@/lib/schema";
import { BRAIN_SYSTEM_PROMPT, FEW_SHOT_EXAMPLES } from "@/lib/brain-prompt";
import { normalizeProducts } from "@/lib/normalize";
import { attachImages, hasImageIntent } from "@/lib/image-match";
import {
  isTrivialMessage,
  trivialReply,
  classifyIntent,
  chatReply,
} from "@/lib/router";
import { discoverKey } from "@/lib/env";

// Vercel: Hobby plan allows up to 300s. We use 290s so large catalog
// generations (50-100 products) finish in a single call instead of
// timing out at the old 60s ceiling.
export const maxDuration = 300;

const LLM_TIMEOUT_MS = 280000;
const MAX_PRODUCTS_TO_LLM = 100;
const MAX_HISTORY_MESSAGES = 8;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** Summarize products for the LLM — no image URLs, no raw secrets, cap size. */
function stripForLLM(products: Product[]): Record<string, unknown>[] {
  return products.slice(0, MAX_PRODUCTS_TO_LLM).map((p) => {
    const c: Record<string, unknown> = {
      name: p.name,
      sellingPrice: p.sellingPrice,
      category: p.category,
      status: p.status,
    };
    if (p.id) c.id = p.id;
    if (p.sku) c.sku = p.sku;
    if (p.costPrice != null) c.costPrice = p.costPrice;
    if (p.inventory != null) c.inventory = p.inventory;
    if (p.imageUrl) c.imageUrl = p.imageUrl;
    if (p.options?.length) {
      c.options = p.options.map((o) => ({
        name: o.name,
        type: o.type,
        variantCount: o.variants.length,
        variantNames: o.variants.map((v: { name: string }) => v.name),
        nestedOptions: (o.variants[0]?.nestedOptions ?? []).map(
          (n: { name: string; variants: { name: string }[] }) => ({
            name: n.name,
            variantNames: n.variants.map((v) => v.name),
          })
        ),
      }));
    }
    return c;
  });
}

function parseBrainResponse(text: string): BrainResponse {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    try {
      const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) data = JSON.parse(m[1].trim());
      else {
        const s = text.indexOf("{");
        const e = text.lastIndexOf("}") + 1;
        if (s !== -1 && e > s) data = JSON.parse(text.slice(s, e));
        else throw new Error("No JSON found");
      }
    } catch {
      // Log the raw model output for debugging before failing
      console.error("[brain] Unparseable model output:", text.slice(0, 2000));
      throw new Error(
        "The model's output was cut off or malformed (likely too many products in one request — try 5-10 per prompt)."
      );
    }
  }

  // Lenient structure check — LLMs routinely slip casing ("LIST" vs "list")
  // or omit optional fields. normalizeProducts() coerces those safely
  // afterwards. Only fail when the shape is genuinely unusable.
  const obj = data as { products?: unknown; assistantMessage?: unknown; clarifyingQuestion?: unknown };
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.products)) {
    throw new Error("Model output did not contain a products array");
  }

  return {
    products: obj.products as BrainResponse["products"],
    assistantMessage:
      typeof obj.assistantMessage === "string"
        ? obj.assistantMessage
        : "Done. Review the product list.",
    clarifyingQuestion:
      typeof obj.clarifyingQuestion === "string"
        ? obj.clarifyingQuestion
        : undefined,
  } as BrainResponse;
}

async function callGeminiWithModel(
  systemPrompt: string,
  turns: Turn[],
  model: string,
  apiKey: string
): Promise<{ text: string | null; error: string | null }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const contents = turns.map((t) => ({
    role: t.role === "user" ? "user" : "model",
    parts: [{ text: t.content }],
  }));
  const payload = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.4, maxOutputTokens: 65536 },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (res.ok) {
      const d = await res.json();
      const finishReason = d.candidates?.[0]?.finishReason;
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text || null;
      if (text && finishReason === "MAX_TOKENS") {
        return { text, error: `${model}: output truncated (MAX_TOKENS)` };
      }
      return { text, error: null };
    }
    return { text: null, error: `${model}: ${res.status}` };
  } catch {
    return { text: null, error: `${model}: timed out or unreachable` };
  }
}

async function callDeepSeek(
  systemPrompt: string,
  turns: Turn[],
  apiKey: string
): Promise<{ text: string | null; error: string | null }> {
  const url = "https://api.deepseek.com/v1/chat/completions";
  const payload = {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: systemPrompt },
      ...turns.map((t) => ({ role: t.role, content: t.content })),
    ],
    temperature: 0.4,
    max_tokens: 65536,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (res.ok) {
      const d = await res.json();
      const finishReason = d.choices?.[0]?.finish_reason;
      const text = d.choices?.[0]?.message?.content || null;
      if (text && finishReason === "length") {
        return { text, error: "DeepSeek: output truncated (length)" };
      }
      return { text, error: null };
    }
    return { text: null, error: `DeepSeek: ${res.status}` };
  } catch {
    return { text: null, error: "DeepSeek: timed out or unreachable" };
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = BrainRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { prompt, currentProducts } = parsed.data;
    const hasProducts = currentProducts && currentProducts.length > 0;

    const geminiKey = discoverKey("GEMINI_API_KEY") || discoverKey("LLM_API_KEY");
    if (!geminiKey) {
      return NextResponse.json(
        { error: "No API key configured" },
        { status: 500 }
      );
    }

    const geminiModel = process.env.GEMINI_MODEL || "gemini-3.6-flash";
    const deepseekKey = discoverKey("DEEPSEEK_API_KEY");
    const history = parsed.data.history || [];

    // ── TIER 1: Trivial filler ("ok", "thanks") → instant, zero LLM ──
    if (isTrivialMessage(prompt)) {
      return NextResponse.json(trivialReply(prompt));
    }

    // ── TIER 2: Classify intent with a cheap model ──
    const intent = await classifyIntent(prompt, hasProducts, geminiKey);

    // ── TIER 3: Chat → lightweight agent (has history, fast) ──
    if (intent === "chat") {
      const reply = await chatReply(prompt, history, geminiKey, deepseekKey);
      // CRITICAL: echo the current products back unchanged — the client
      // replaces its grid with whatever this returns. An empty array would
      // wipe loaded products on small talk.
      reply.products = currentProducts as BrainResponse["products"];
      return NextResponse.json(reply);
    }

    // ── TIER 4: csv_create / csv_edit → the full brain ──
    let userMsg: string;
    if (hasProducts) {
      const stripped = stripForLLM(currentProducts);
      userMsg = `Edit these ${stripped.length} products: ${prompt}\n\nProducts:\n${JSON.stringify(stripped)}`;
    } else {
      userMsg = `${prompt}\n\nReturn JSON with "products", "assistantMessage", optionally "clarifyingQuestion". If vague, return empty products and a clarifying question.`;
    }

    // Build the conversation: few-shots → history → current message.
    // Few-shots and history give the model session context ("add a large
    // size to all of them" now refers to earlier turns).
    const turns: Turn[] = [
      ...FEW_SHOT_EXAMPLES.map((ex) => ({
        role: ex.role,
        content: ex.content,
      })),
      ...(history).slice(-MAX_HISTORY_MESSAGES).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user" as const, content: userMsg },
    ];

    // DeepSeek first (verified working), then Gemini as fallback — 1 attempt each.
    // Truncated text (MAX_TOKENS/length) is kept as a last resort: a partial
    // catalog beats an error. We only discard text on hard failures.
    let text: string | null = null;
    let truncated = false;
    let errors: string[] = [];
    if (deepseekKey) {
      const { text: t, error } = await callDeepSeek(
        BRAIN_SYSTEM_PROMPT,
        turns,
        deepseekKey
      );
      if (t && !error) text = t;
      else if (t && error) {
        text = t;
        truncated = true;
      } else if (error) errors.push(error);
    }
    if (!text) {
      for (const model of [geminiModel, "gemini-3.5-flash"]) {
        const { text: t, error } = await callGeminiWithModel(
          BRAIN_SYSTEM_PROMPT,
          turns,
          model,
          geminiKey
        );
        if (t && !error) {
          text = t;
          truncated = false;
          break;
        }
        if (t && error) {
          text = t;
          truncated = true;
          break;
        }
        if (error) errors.push(error);
      }
    }

    if (!text) {
      return NextResponse.json(
        {
          error: "All models unavailable",
          message: `Tried Gemini + DeepSeek — all failed. ${errors.join("; ")}. Wait a moment and retry.`,
        },
        { status: 502 }
      );
    }

    let responseData: BrainResponse;
    try {
      responseData = parseBrainResponse(text);
    } catch (err: unknown) {
      return NextResponse.json(
        {
          error: "Could not parse model response",
          message: err instanceof Error ? err.message : "Invalid model output",
        },
        { status: 500 }
      );
    }

    if (truncated) {
      responseData.assistantMessage =
        (responseData.assistantMessage || "") +
        " (Note: the response was cut off at the model's output limit — some products may be missing. Try fewer products per prompt.)";
    }

    responseData.products = normalizeProducts(
      responseData.products as unknown as Record<string, unknown>[]
    ) as BrainResponse["products"];

    // If the user asked for images, run the two-prompt match pipeline:
    // build search query → grade top-5 → fallback → blank. Never settle
    // for a loosely-related photo.
    let imageNote = "";
    if (hasImageIntent(prompt)) {
      try {
        const { products: withImages, report } = await attachImages(
          responseData.products as unknown as Product[]
        );
        responseData.products = withImages as unknown as BrainResponse["products"];
        imageNote = ` Images: matched ${report.matched}, blank ${report.blank}, inherited ${report.inherited}, skipped ${report.skipped}.`;
      } catch {
        imageNote = " Image matching failed — images left blank.";
      }
      responseData.assistantMessage = (responseData.assistantMessage || "") + imageNote;
    }

    return NextResponse.json(responseData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
