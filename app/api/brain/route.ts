import { NextResponse } from "next/server";
import {
  BrainRequestSchema,
  type BrainResponse,
  type Product,
} from "@/lib/schema";
import { BRAIN_SYSTEM_PROMPT, FEW_SHOT_EXAMPLES } from "@/lib/brain-prompt";
import { normalizeProducts } from "@/lib/normalize";
import { attachImages, hasImageIntent } from "@/lib/image-match";
import { mergeProducts } from "@/lib/patch-merge";
import {
  isTrivialMessage,
  trivialReply,
  classifyIntent,
  chatReply,
  type Intent,
} from "@/lib/router";
import { discoverKey } from "@/lib/env";
import { authorizeEdit, extractNumericOps, applyNumericOp, resolveFieldTargetLLM } from "@/lib/edit-intent";
import { deepDiffProducts, restoreEntries } from "@/lib/deep-diff";
import { deriveSessionState, sessionBlock, type SessionState } from "@/lib/session";
import { judgeComplexity, type ComplexityVerdict } from "@/lib/complexity";
import { stripForLLM } from "@/lib/strip";

// Vercel: Hobby plan allows up to 300s. We use 290s so large catalog
// generations (50-100 products) finish in a single call instead of
// timing out at the old 60s ceiling.
export const maxDuration = 300;

const LLM_TIMEOUT_MS = 280000;
const MAX_HISTORY_MESSAGES = 8;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

function parseBrainResponse(text: string, allowRawArray = false): BrainResponse {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    try {
      const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) data = JSON.parse(m[1].trim());
      else {
        // Try array-first: patch edits return a raw product array
        const s = text.indexOf("[");
        const e = text.lastIndexOf("]") + 1;
        if (allowRawArray && s !== -1 && e > s) {
          data = JSON.parse(text.slice(s, e));
        } else {
          const s2 = text.indexOf("{");
          const e2 = text.lastIndexOf("}") + 1;
          if (s2 !== -1 && e2 > s2) data = JSON.parse(text.slice(s2, e2));
          else throw new Error("No JSON found");
        }
      }
    } catch {
      // Log the raw model output for debugging before failing
      console.error("[brain] Unparseable model output:", text.slice(0, 2000));
      throw new Error(
        "The model's output was cut off or malformed (likely too many products in one request — try 5-10 per prompt)."
      );
    }
  }

  // Raw array format (patch edit) — the whole response is the changed products
  if (allowRawArray && Array.isArray(data)) {
    return {
      products: data as BrainResponse["products"],
      assistantMessage: "Done. Review the product list.",
    } as BrainResponse;
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
  apiKey: string,
  opts: { thinking?: boolean } = {}
): Promise<{ text: string | null; error: string | null }> {
  const url = "https://api.deepseek.com/v1/chat/completions";
  // Thinking mode: enabled with high effort for complex tasks, EXPLICITLY
  // disabled for simple ones (the API defaults it ON, which would burn
  // tokens and latency on trivial edits).
  const thinking = opts.thinking ?? false;
  const payload: Record<string, unknown> = {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: systemPrompt },
      ...turns.map((t) => ({ role: t.role, content: t.content })),
    ],
    max_tokens: 65536,
  };
  if (thinking) {
    payload.thinking = { type: "enabled" };
    payload.reasoning_effort = "high";
  } else {
    payload.thinking = { type: "disabled" };
    payload.temperature = 0.4;
  }

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

    // ── TIER 2: Classify intent — conversation-aware ──
    // If the assistant's last message was a question (e.g. a clarifying
    // question about products), the user's reply is an ANSWER to it and
    // must reach the brain — never the chat agent. This fixes "pic random
    // cuisine" being misrouted as small talk when the classifier is down.
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    const answeringClarification =
      !!lastAssistant && lastAssistant.content.trim().endsWith("?");

    let intent: Intent;
    if (answeringClarification) {
      intent = hasProducts ? "csv_edit" : "csv_create";
    } else {
      intent = await classifyIntent(prompt, hasProducts, geminiKey);
    }

    // ── TIER 3: Chat → lightweight agent (has history, fast) ──
    if (intent === "chat") {
      const reply = await chatReply(prompt, history, geminiKey, deepseekKey);
      // CRITICAL: echo the current products back unchanged — the client
      // replaces its grid with whatever this returns. An empty array would
      // wipe loaded products on small talk.
      reply.products = currentProducts as BrainResponse["products"];
      return NextResponse.json(reply);
    }

    // ── IMAGE-ONLY SHORTCUT ──
    // If products are already loaded and the user ONLY asked for images
    // (no other field/edit intent), skip the LLM entirely — running it
    // would reconstruct the product list from a summary and can silently
    // DROP nestedOptions. Attach images directly to intact data instead.
    // Guard: only when the prompt is purely about images — an edit like
    // "Pick Your Bottle" must never hit this path (word-boundary fix).
    const imgAuth = authorizeEdit(prompt);
    const isImageOnly =
      hasImageIntent(prompt) &&
      imgAuth.fields.size === 1 &&
      imgAuth.fields.has("imageUrl") &&
      !imgAuth.touchesOptions;

    if (hasProducts && isImageOnly) {
      try {
        const { products: withImages, report } = await attachImages(
          currentProducts as Product[]
        );
        return NextResponse.json({
          products: withImages as BrainResponse["products"],
          assistantMessage:
            `Attached images: ${report.matched} matched, ${report.blank} blank, ${report.inherited} inherited, ${report.skipped} skipped. ` +
            `All existing options and nested add-ons preserved.`,
        });
      } catch (err: unknown) {
        return NextResponse.json(
          {
            error: "Image matching failed",
            message:
              err instanceof Error
                ? err.message
                : "Could not attach images. Products left unchanged.",
          },
          { status: 500 }
        );
      }
    }

    // ── TIER 4: csv_create / csv_edit → the full brain ──
    // Intelligence layer: derive the session (goal, last action, turn
    // continuity) and judge task complexity. Simple tasks run thinking
    // OFF with a compact product view (fast, cheap); complex tasks run
    // thinking ON with the full catalog view (slow, careful).
    const session: SessionState = deriveSessionState(
      history,
      prompt,
      currentProducts as Product[]
    );
    const verdict: ComplexityVerdict = judgeComplexity(
      prompt,
      session,
      currentProducts as Product[],
      intent === "csv_create" ? "csv_create" : "csv_edit"
    );
    console.log(
      "[brain] complexity:",
      verdict.tier,
      `(score ${verdict.score}: ${verdict.reasons.join("; ") || "no signals"})`,
      "thinking:",
      verdict.thinking ? "on" : "off",
      "context:",
      verdict.context
    );

    let userMsg: string;
    if (hasProducts) {
      const stripped = stripForLLM(currentProducts, verdict.context);
      const directive =
        verdict.tier === "complex"
          ? "This is a COMPLEX task — reason carefully about scope, conditions, and exclusions before editing."
          : "This is a SIMPLE targeted change — change exactly what was asked and nothing else.";
      // PATCH-STYLE EDIT: the model returns ONLY the products it changed,
      // not the entire catalog. Echoing everything blows the output token
      // cap on large CSVs (the "cut off or malformed" error). Code merges
      // the returned products back onto the originals.
      userMsg = `${sessionBlock(session)}

${directive}

You are editing a catalog of ${stripped.length} products.

${prompt}

Return ONLY the products that were CHANGED by this instruction (full product objects, with all their options/variants intact). Do NOT return unchanged products. If a change applies to all products, return all of them.
Do NOT include a "products" key — return a raw JSON array of the changed products.

Current catalog (for reference):
${JSON.stringify(stripped)}`;
    } else {
      userMsg = `${sessionBlock(session)}

${prompt}\n\nReturn JSON with "products", "assistantMessage", optionally "clarifyingQuestion". If vague, return empty products and a clarifying question.`;
    }

    // Build the conversation: few-shots → history → current message.
    // Few-shots and history give the model session context ("add a large
    // size to all of them" now refers to earlier turns). Complex tasks
    // get a longer history window — they need the full thread.
    const historyWindow = verdict.tier === "complex" ? 12 : MAX_HISTORY_MESSAGES;
    const turns: Turn[] = [
      ...FEW_SHOT_EXAMPLES.map((ex) => ({
        role: ex.role,
        content: ex.content,
      })),
      ...(history).slice(-historyWindow).map((m) => ({
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
        deepseekKey,
        { thinking: verdict.thinking }
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
      responseData = parseBrainResponse(text, intent === "csv_edit");
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

    // ── Authorize early (needed by both merge + diff steps) ──
    let editAuth: ReturnType<typeof authorizeEdit> | null = null;
    if (intent === "csv_edit" && hasProducts) {
      editAuth = authorizeEdit(prompt);
      if (!editAuth.hasFieldTarget) {
        const resolved = await resolveFieldTargetLLM(prompt, deepseekKey || geminiKey);
        if (resolved) {
          if (resolved === "options") {
            editAuth = { hasFieldTarget: true, fields: new Set(), touchesOptions: true, removeOptions: false, summary: "options" };
          } else {
            editAuth = { hasFieldTarget: true, fields: new Set([resolved]), touchesOptions: false, removeOptions: false, summary: resolved };
          }
        }
      }
      if (!editAuth.hasFieldTarget) {
        return NextResponse.json({
          products: currentProducts as BrainResponse["products"],
          assistantMessage: editAuth.reason,
          clarifyingQuestion: editAuth.reason,
        });
      }
    }

    // ── PATCH MERGE (edit mode) ──
    // Smart option-aware merge: preserves originals' options the
    // model didn't touch, only updates options by name or adds new
    // ones. Spread-overwrite was destroying options the model omitted.
    let editNote = "";
    if (intent === "csv_edit" && hasProducts) {
      const changed = responseData.products as unknown as Product[];
      // Replicate new options catalog-wide only when the instruction
      // suggests a broad scope ("all", "every", "category", "each")
      const catalogWide =
        /\b(all|every|each|category|categories|both|any)\b/i.test(prompt) ||
        changed.filter((c) => (c.options || []).length > (currentProducts.find((o) => (o.id && o.id === c.id) || (o.name === c.name))?.options?.length ?? 0)).length >= 2;
      const mergeResult = mergeProducts(
        currentProducts,
        changed,
        editAuth?.removeOptions ?? false,
        catalogWide
      );
      responseData.products = mergeResult.products as unknown as BrainResponse["products"];

      // Post-merge sanity: did option count drop? If so, the model
      // lost data — surface it but don't overwrite the user's work.
      const beforeOptCount = currentProducts.reduce(
        (s, p) => s + (p.options || []).length,
        0
      );
      const afterOptCount = mergeResult.products.reduce(
        (s, p) => s + (p.options || []).length,
        0
      );
      if (afterOptCount < beforeOptCount && !editAuth?.removeOptions) {
        editNote += ` ⚠️ ${beforeOptCount - afterOptCount} option(s) vanished during edit — review the grid before exporting.`;
      }
      if (mergeResult.addedOptions > 0 || mergeResult.updatedOptions > 0) {
        editNote += ` Options: ${mergeResult.addedOptions} added, ${mergeResult.updatedOptions} updated, ${mergeResult.preservedOptions} preserved unchanged.`;
      }
    }

    // ── EDIT SAFETY DEEP-DIFF & RESTORE ──
    if (intent === "csv_edit" && hasProducts && editAuth) {
      // Apply deterministic numeric ops first (authorized by keyword)
      let patched = responseData.products as unknown as Product[];
      const numericOps = extractNumericOps(prompt);
      if (numericOps.length > 0) {
        for (const op of numericOps) editAuth.fields.add(op.targetField);
        patched = patched.map((p) => numericOps.reduce((acc, op) => applyNumericOp(acc, op), p));
        responseData.products = patched as unknown as BrainResponse["products"];
      }

      // Diff original vs result; revert anything not authorized
      const diffs = deepDiffProducts(currentProducts, responseData.products as unknown as Product[]);
      const unauthorized = diffs.filter((d) => !editAuth.fields.has(d.rootField) && !editAuth.touchesOptions);
      console.log("[debug] editAuth fields:", [...editAuth.fields], "touchesOptions:", editAuth.touchesOptions, "inventory:", (responseData.products as unknown as Product[])[0]?.inventory, "unauth count:", unauthorized.length);
      if (unauthorized.length > 0) {
        responseData.products = restoreEntries(
          responseData.products as unknown as Product[],
          unauthorized
        ) as unknown as BrainResponse["products"];
        const paths = [...new Set(unauthorized.map((d) => d.path))].slice(0, 5).join(", ");
        editNote += ` Preserved ${unauthorized.length} unmentioned field(s) the model tried to change (${paths}...).`;
      }
    }

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
    }

    // ── Completion summary ──
    // Tell the user what was actually done, plus the import-error invite.
    const doneProducts = responseData.products as unknown as Product[];
    const optCount = doneProducts.reduce(
      (sum, p) => sum + (p.options || []).length,
      0
    );
    const variantCount = doneProducts.reduce(
      (sum, p) =>
        sum +
        (p.options || []).reduce(
          (s, o) => s + (o.variants || []).length,
          0
        ),
      0
    );
    const nestedCount = doneProducts.reduce(
      (sum, p) =>
        sum +
        (p.options || []).reduce(
          (s, o) =>
            s +
            (o.variants || []).reduce(
              (s2, v) => s2 + (v.nestedOptions || []).length,
              0
            ),
          0
        ),
      0
    );

    const summary = `\n\n✅ Done — ${doneProducts.length} product${
      doneProducts.length !== 1 ? "s" : ""
    }${intent === "csv_edit" ? " updated" : " created"}${
      optCount > 0 ? ` with ${optCount} option group${optCount !== 1 ? "s" : ""}` : ""
    }${variantCount > 0 ? ` and ${variantCount} variant${variantCount !== 1 ? "s" : ""}` : ""}${
      nestedCount > 0 ? ` (${nestedCount} nested add-on${nestedCount !== 1 ? "s" : ""})` : ""
    }. Review the grid, then click Export CSV.
\nIf you get any error while importing this CSV, paste it here and I'll fix it.`;

    responseData.assistantMessage =
      (responseData.assistantMessage || "").replace(/\s+$/, "") + imageNote + editNote + summary;

    return NextResponse.json(responseData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
