import { NextResponse } from "next/server";
import {
  BrainRequestSchema,
  BrainResponseSchema,
  type BrainResponse,
  type Product,
} from "@/lib/schema";
import { BRAIN_SYSTEM_PROMPT, FEW_SHOT_EXAMPLES } from "@/lib/brain-prompt";
import { normalizeProducts } from "@/lib/normalize";

// Vercel: allow up to 60s for LLM calls (Hobby plan max)
export const maxDuration = 60;

const LLM_TIMEOUT_MS = 50000;
const MAX_PRODUCTS_TO_LLM = 100;
const MAX_HISTORY_MESSAGES = 8;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

function discoverKey(varName: string): string | null {
  const fromEnv = process.env[varName];
  if (fromEnv) return fromEnv;
  try {
    const fs = require("fs");
    const path = require("path");
    for (const p of [
      path.resolve("c:\\Hyperzod_repo\\bountystrike\\.env"),
      path.join(process.cwd(), "..", "bountystrike", ".env"),
      path.join(process.cwd(), ".env"),
    ]) {
      try {
        const content = fs.readFileSync(p, "utf-8");
        for (const line of content.split("\n")) {
          const re = new RegExp(`^${varName}\\s*=\\s*(.+)$`);
          const match = line.match(re);
          if (match) {
            const val = match[1].trim().replace(/^["']|["']$/g, "");
            if (val) return val;
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return null;
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
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) data = JSON.parse(m[1].trim());
    else {
      const s = text.indexOf("{");
      const e = text.lastIndexOf("}") + 1;
      if (s !== -1 && e > s) data = JSON.parse(text.slice(s, e));
      else throw new Error("No JSON found");
    }
  }

  // Validate against the strict schema (B6) — garbage fails fast.
  const parsed = BrainResponseSchema.safeParse(data);
  if (parsed.success) return parsed.data;

  // Salvage: try products alone; otherwise report the shape error.
  if (data && typeof data === "object" && Array.isArray((data as { products?: unknown }).products)) {
    const salvage = BrainResponseSchema.safeParse({
      products: (data as { products: unknown }).products,
      assistantMessage: "Done. Review the product list.",
    });
    if (salvage.success) return salvage.data;
  }

  throw new Error(
    "Model output did not match the expected schema: " +
      parsed.error.issues.map((i) => i.path.join(".")).slice(0, 5).join(", ")
  );
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
    generationConfig: { temperature: 0.4, maxOutputTokens: 16384 },
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
      return { text: d.candidates?.[0]?.content?.parts?.[0]?.text || null, error: null };
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
    max_tokens: 16384,
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
      return { text: d.choices?.[0]?.message?.content || null, error: null };
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
      ...(parsed.data.history || []).slice(-MAX_HISTORY_MESSAGES).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user" as const, content: userMsg },
    ];

    // DeepSeek first (verified working), then Gemini as fallback — 1 attempt each
    let text: string | null = null;
    let errors: string[] = [];
    if (deepseekKey) {
      const { text: t, error } = await callDeepSeek(
        BRAIN_SYSTEM_PROMPT,
        turns,
        deepseekKey
      );
      if (t) text = t;
      else if (error) errors.push(error);
    }
    if (!text) {
      for (const model of [geminiModel, "gemini-3.5-flash"]) {
        const { text: t, error } = await callGeminiWithModel(
          BRAIN_SYSTEM_PROMPT,
          turns,
          model,
          geminiKey
        );
        if (t) {
          text = t;
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

    responseData.products = normalizeProducts(
      responseData.products as unknown as Record<string, unknown>[]
    ) as BrainResponse["products"];

    return NextResponse.json(responseData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
