import { NextResponse } from "next/server";
import {
  BrainRequestSchema,
  type BrainResponse,
  type Product,
} from "@/lib/schema";
import { BRAIN_SYSTEM_PROMPT, FEW_SHOT_EXAMPLES } from "@/lib/brain-prompt";

function discoverKey(varName: string): string | null {
  const fromEnv = process.env[varName];
  if (fromEnv) return fromEnv;

  try {
    const fs = require("fs");
    const path = require("path");
    const envPaths = [
      path.resolve("c:\\Hyperzod_repo\\bountystrike\\.env"),
      path.join(process.cwd(), "..", "bountystrike", ".env"),
      path.join(process.cwd(), ".env"),
    ];
    for (const p of envPaths) {
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
        // skip
      }
    }
  } catch {
    // skip
  }
  return null;
}

function stripForLLM(products: Product[]): Record<string, unknown>[] {
  return products.map((p) => {
    const cleaned: Record<string, unknown> = {
      name: p.name,
      sellingPrice: p.sellingPrice,
      category: p.category,
      status: p.status,
    };
    if (p.description) cleaned.description = p.description;
    if (p.sku) cleaned.sku = p.sku;
    if (p.costPrice != null) cleaned.costPrice = p.costPrice;
    if (p.priceCompare != null) cleaned.priceCompare = p.priceCompare;
    if (p.minQty != null) cleaned.minQty = p.minQty;
    if (p.maxQty != null) cleaned.maxQty = p.maxQty;
    if (p.taxPercent != null) cleaned.taxPercent = p.taxPercent;
    if (p.inventory != null) cleaned.inventory = p.inventory;
    if (p.labels?.length) cleaned.labels = p.labels;
    if (p.tags?.length) cleaned.tags = p.tags;
    if (p.imageUrl) cleaned.imageUrl = p.imageUrl;
    if (p.options?.length) {
      cleaned.options = p.options.map((o) => ({
        name: o.name,
        type: o.type,
        variantCount: o.variants.length,
        variantNames: o.variants.map((v: { name: string }) => v.name),
      }));
    }
    return cleaned;
  });
}

function parseResponse(textContent: string): BrainResponse {
  let responseData: BrainResponse;

  try {
    responseData = JSON.parse(textContent);
  } catch {
    const jsonMatch = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      responseData = JSON.parse(jsonMatch[1].trim());
    } else {
      const jsonStart = textContent.indexOf("{");
      const jsonEnd = textContent.lastIndexOf("}") + 1;
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        responseData = JSON.parse(textContent.slice(jsonStart, jsonEnd));
      } else {
        throw new Error("Could not extract JSON from response");
      }
    }
  }

  if (!responseData.products || !Array.isArray(responseData.products)) {
    responseData.products = [];
  }
  if (!responseData.assistantMessage) {
    responseData.assistantMessage =
      "I've processed your request. Review the product list and make any adjustments needed.";
  }
  return responseData;
}

function normalizeProducts(products: Record<string, unknown>[]) {
  return products.map((p: Record<string, unknown>) => {
    const rawOptions = Array.isArray(p.options)
      ? p.options.map((o: Record<string, unknown>) => ({
          name: o.name || "Option",
          type: o.type === "multiple" ? "multiple" : "single",
          enableRange: !!o.enableRange,
          range:
            Array.isArray(o.range) && o.range.length === 2 ? o.range : [0, 0],
          required: !!o.required,
          view: o.view === "card" ? "card" : "list",
          variants: Array.isArray(o.variants)
            ? o.variants
                .map((v: Record<string, unknown>) => ({
                  name: v.name || "Variant",
                  price: typeof v.price === "number" ? v.price : 0,
                  costPrice:
                    typeof v.costPrice === "number" ? v.costPrice : undefined,
                  minQty: typeof v.minQty === "number" ? v.minQty : 0,
                  maxQty:
                    typeof v.maxQty === "number" ? v.maxQty : undefined,
                  description: v.description || "",
                  imageUrl: v.imageUrl || "",
                  nestedOptions: Array.isArray(v.nestedOptions)
                    ? v.nestedOptions
                    : [],
                }))
                .filter(
                  (v: Record<string, unknown>) =>
                    v.name && v.name !== "Variant"
                )
            : [],
        }))
      : [];

    const validOptions = rawOptions.filter(
      (o: Record<string, unknown>) =>
        Array.isArray(o.variants) && o.variants.length > 0
    );

    return {
      name: p.name || "Untitled Product",
      description: p.description || "",
      sku: p.sku || "",
      sellingPrice: typeof p.sellingPrice === "number" ? p.sellingPrice : 0,
      costPrice:
        typeof p.costPrice === "number" && p.costPrice > 0
          ? p.costPrice
          : Math.round((typeof p.sellingPrice === "number" ? p.sellingPrice : 0) * 0.4 * 100) / 100,
      priceCompare:
        typeof p.priceCompare === "number" ? p.priceCompare : undefined,
      minQty: typeof p.minQty === "number" ? p.minQty : undefined,
      maxQty: typeof p.maxQty === "number" ? p.maxQty : undefined,
      taxPercent:
        typeof p.taxPercent === "number" ? p.taxPercent : undefined,
      status: p.status === "inactive" ? "inactive" : "active",
      inventory: typeof p.inventory === "number" ? p.inventory : undefined,
      labels: Array.isArray(p.labels) ? p.labels : [],
      category: p.category || "General",
      tags: Array.isArray(p.tags) ? p.tags : [],
      imageUrl: p.imageUrl || "",
      options: validOptions,
      _fieldConfidence: p._fieldConfidence || {},
    };
  });
}

async function callGemini(
  fullPrompt: string,
  apiKey: string,
  model: string
): Promise<{ text: string | null; error: string | null }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 65536,
    },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        return {
          text: data.candidates?.[0]?.content?.parts?.[0]?.text || null,
          error: null,
        };
      }
      if (res.status === 429 || res.status === 503) continue;
      return { text: null, error: `${model}: ${res.status}` };
    } catch {
      continue;
    }
  }
  return { text: null, error: `${model}: exhausted` };
}

async function callDeepSeek(
  systemPrompt: string,
  userMessage: string,
  apiKey: string
): Promise<{ text: string | null; error: string | null }> {
  const url = "https://api.deepseek.com/v1/chat/completions";
  const payload = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.7,
    max_tokens: 16384,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        return {
          text: data.choices?.[0]?.message?.content || null,
          error: null,
        };
      }
      if (res.status === 429 || res.status === 503) continue;
      const errBody = await res.text();
      return { text: null, error: `DeepSeek: ${res.status} — ${errBody.slice(0, 200)}` };
    } catch {
      continue;
    }
  }
  return { text: null, error: "DeepSeek: exhausted" };
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

    let userPrompt: string;
    if (hasProducts) {
      const stripped = stripForLLM(currentProducts);
      userPrompt = `I have ${stripped.length} existing products. Here's the instruction: ${prompt}\n\nExisting products (summary):\n${JSON.stringify(stripped, null, 2)}\n\nModify existing products based on my instruction. Only change what I asked. Return ONLY a valid JSON object with "products", "assistantMessage", and optionally "clarifyingQuestion".`;
    } else {
      userPrompt = `${prompt}\n\nReturn ONLY a valid JSON object with "products" (array), "assistantMessage" (string), and optionally "clarifyingQuestion" (string). If the prompt is too vague, return empty products and a clarifying question.`;
    }

    const fullPrompt = `${BRAIN_SYSTEM_PROMPT}\n\n${FEW_SHOT_EXAMPLES.map(
      (ex) => {
        if (ex.role === "user") return `User: ${ex.content}`;
        return `Assistant: ${ex.content}`;
      }
    ).join("\n\n")}\n\nUser: ${userPrompt}\n\nAssistant:`;

    // --- Try Gemini first ---
    const geminiKey =
      discoverKey("GEMINI_API_KEY") || discoverKey("LLM_API_KEY");
    const geminiModel = process.env.GEMINI_MODEL || "gemini-3.6-flash";

    let textContent: string | null = null;
    let errors: string[] = [];

    if (geminiKey) {
      for (const model of [
        geminiModel,
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-2.5-flash",
      ]) {
        const { text, error } = await callGemini(fullPrompt, geminiKey, model);
        if (text) {
          textContent = text;
          break;
        }
        if (error) errors.push(error);
      }
    }

    // --- Fallback to DeepSeek ---
    if (!textContent) {
      const deepseekKey = discoverKey("DEEPSEEK_API_KEY");
      if (deepseekKey) {
        const { text, error } = await callDeepSeek(
          BRAIN_SYSTEM_PROMPT,
          userPrompt,
          deepseekKey
        );
        if (text) {
          textContent = text;
        } else if (error) {
          errors.push(error);
        }
      } else {
        errors.push("No DeepSeek API key configured");
      }
    }

    if (!textContent) {
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
      responseData = parseResponse(textContent);
    } catch {
      return NextResponse.json(
        {
          error: "Could not parse model response",
          message:
            "The model returned an invalid response. Try again with a simpler prompt.",
        },
        { status: 500 }
      );
    }

    responseData.products = normalizeProducts(
      responseData.products as Record<string, unknown>[]
    );

    return NextResponse.json(responseData);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
