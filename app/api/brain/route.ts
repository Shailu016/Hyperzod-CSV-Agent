import { NextResponse } from "next/server";
import { dedupeSkus } from "@/lib/dedupe-skus";
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
import { checkScale } from "@/lib/scale-estimator";
import {
  computeBatchPlan,
  buildBatchPrompt,
  extractCategories,
  summarizeProducts,
  progressMsg,
  parseBatchProgress,
} from "@/lib/batch-processor";

// Vercel: Hobby plan allows up to 300s. We use 290s so large catalog
// generations (50-100 products) finish in a single call instead of
// timing out at the old 60s ceiling.
export const maxDuration = 300;

const LLM_TIMEOUT_MS = 280000;
const MAX_HISTORY_MESSAGES = 8;

// Shared spec for both fresh batches and "continue" batches — the model
// MUST be told the required fields, otherwise it returns bare products
// and normalize silently fills 0/0/no-options.
const CREATE_SYSTEM_PROMPT = `You are a catalog builder. Return ONLY a raw JSON array of products - no "products" wrapper, no assistantMessage, just the array. Each product object must have: name, sellingPrice, category, status. Optional: description, sku, costPrice, inventory, labels, tags, imageUrl, options (with variants). Use realistic Hindi/Indian-friendly product names when possible.`;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

function parseBrainResponse(text: string, allowRawArray = false): BrainResponse {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  let data: unknown = tryParse(text);

  // Code-fenced JSON: ```json {...} ```
  if (data === undefined) {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) data = tryParse(m[1].trim());
  }

  // Raw array slice — the model may return just the products array in ANY
  // mode (create or edit), with commentary around it. Slicing between the
  // outermost brackets handles that.
  if (data === undefined) {
    const s = text.indexOf("[");
    const e = text.lastIndexOf("]") + 1;
    if (s !== -1 && e > s) data = tryParse(text.slice(s, e));
  }

  // Object slice — fallback when the model wrapped output in prose.
  if (data === undefined) {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}") + 1;
    if (s !== -1 && e > s) data = tryParse(text.slice(s, e));
  }

  if (data === undefined) {
    // Log the raw model output for debugging before failing
    console.error("[brain] Unparseable model output:", text.slice(0, 2000));
    throw new Error(
      "The model's output was cut off or malformed (likely too many products in one request — try 5-10 per prompt)."
    );
  }

  // Raw array format — the whole response is the product list
  if (Array.isArray(data)) {
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
    // json_object mode forces an object wrapper — the model may have put
    // the array under a different key ("result", "items", "data"...).
    if (obj && typeof obj === "object") {
      const wrappedArray = Object.values(obj).find(Array.isArray);
      if (wrappedArray) {
        return {
          products: wrappedArray as BrainResponse["products"],
          assistantMessage: "Done. Review the product list.",
        } as BrainResponse;
      }
    }
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
    // Force valid JSON output at the API level — the model literally cannot
    // emit malformed JSON when the API enforces it. This eliminates the
    // entire class of "cut off or malformed" parse errors.
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 65536,
      responseMimeType: "application/json",
    },
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
    // Force valid JSON at the API level. DeepSeek requires the word "json"
    // to appear in the prompt for json_object mode — all brain prompts
    // already say "Return ONLY a raw JSON array" / "JSON with products".
    response_format: { type: "json_object" },
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
      const reply = trivialReply(prompt);
      reply.products = currentProducts as BrainResponse["products"];
      return NextResponse.json(reply);
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
      // Batch continuation: "continue"/"more" after a batch progress message
      // should resume product creation, not get misrouted as an edit.
      const BATCH_CONTINUE_RE = /^(continue|more|go on|keep going|next|resume)\s*$/i;
      const lastAssistantForBatch = [...history]
        .reverse()
        .find((m) => m.role === "assistant");
      const isBatchContinue =
        BATCH_CONTINUE_RE.test(prompt.trim()) &&
        lastAssistantForBatch &&
        /\bBatch\s+\d+\/\d+\s+done\b/i.test(
          lastAssistantForBatch.content
        ) &&
        hasProducts;
      intent = isBatchContinue
        ? "csv_create"
        : (await classifyIntent(prompt, hasProducts, geminiKey));
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
          products: dedupeSkus(withImages) as BrainResponse["products"],
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

    // ── PRE-FLIGHT SCALE CHECK ──
    // If the requested catalog is too large for a single LLM call, split
    // into batches automatically. Each batch fits within the output token
    // budget. Progress messages are shown to the user while processing.
    if (intent === "csv_create") {
      // ── BATCH CONTINUATION ──
      const batchContRe = /^(continue|more|go on|keep going|next|resume)\s*$/i;
      const lastBatchMsg = [...history]
        .reverse()
        .find((m) => m.role === "assistant");
      const batchProgress = lastBatchMsg
        ? parseBatchProgress(lastBatchMsg.content)
        : null;
      const isContinuation =
        batchContRe.test(prompt.trim()) && batchProgress && hasProducts;

      if (isContinuation) {
        const startBatch = batchProgress.batchNum + 1;
        const originalPrompt = (
          history.find(
            (m) => m.role === "user" && m.content.length > 30
          ) || { content: prompt }
        ).content;

        const origScale = checkScale(originalPrompt, session);
        const categories = extractCategories(originalPrompt);
        const plan = computeBatchPlan(
          origScale.ok
            ? origScale
            : {
                ...origScale,
                productCount: batchProgress.totalBatches * 10,
              }
        );
        if (categories.length > 0) plan.categories = categories;

        console.log(
          `[brain] batch continuation: resuming at batch ${startBatch}/${batchProgress.totalBatches}`
        );

        const remaining = batchProgress.totalBatches - startBatch + 1;
        const contBatchCount = Math.min(
          remaining,
          plan.maxBatchesThisRequest
        );
        let allProducts = (currentProducts as Product[]) || [];
        const batchKey = deepseekKey || geminiKey;
        let previouslyCreated = "";

        for (
          let b = startBatch;
          b < startBatch + contBatchCount && batchKey;
          b++
        ) {
          const batchPrompt = buildBatchPrompt(
            originalPrompt,
            b,
            batchProgress.totalBatches,
            plan.perBatch,
            plan.categories,
            previouslyCreated
          );

          const { text: batchText } = await callDeepSeek(
            CREATE_SYSTEM_PROMPT,
            [{ role: "user", content: batchPrompt }],
            batchKey,
            { thinking: false }
          );

          if (!batchText) break;

          let batchProducts: Product[] = [];
          try {
            const parsed = parseBrainResponse(batchText, true);
            batchProducts = normalizeProducts(
              parsed.products as unknown as Record<string, unknown>[]
            ) as unknown as Product[];
          } catch {
            /* skip malformed batch */
          }

          const existingNames = new Set(
            allProducts.map((p) => p.name.toLowerCase())
          );
          batchProducts = batchProducts.filter(
            (p) => !existingNames.has(p.name.toLowerCase())
          );

          allProducts = allProducts.concat(batchProducts);
          previouslyCreated = summarizeProducts(batchProducts);
        }

        const newBatchEnd = startBatch + contBatchCount - 1;
        const complete = newBatchEnd >= batchProgress.totalBatches;
        const finalMsg =
          progressMsg(
            newBatchEnd,
            batchProgress.totalBatches,
            plan.perBatch,
            complete,
            allProducts.length
          ) +
          (complete
            ? ""
            : `\n\nSay **"continue"** or **"more"** to build the remaining ${
                batchProgress.totalBatches - newBatchEnd
              } batches.`);

        return NextResponse.json({
          products: dedupeSkus(allProducts) as BrainResponse["products"],
          assistantMessage: finalMsg,
        });
      }

      // ── PRE-FLIGHT SCALE CHECK (fresh request) ──
      const scale = checkScale(prompt, session);
      if (!scale.ok) {
        console.log(
          "[brain] scale exceeded — entering batch mode:",
          scale.productCount,
          "products, est",
          scale.estimatedTokens,
          "tokens"
        );

        const categories = extractCategories(prompt);
        const plan = computeBatchPlan(scale);
        // Override the extracted categories if we found them
        if (categories.length > 0) {
          plan.categories = categories;
        }

        console.log(
          "[brain] batch plan:",
          plan.batches,
          "batches of",
          plan.perBatch,
          "products each,",
          plan.categories.length,
          "categories"
        );

        const batchKey = deepseekKey || geminiKey;
        if (!batchKey) {
          return NextResponse.json(
            { error: "No API key configured for batch processing" },
            { status: 500 }
          );
        }

        // Process batches — limited to what fits in Vercel 290s
        const batchCount = Math.min(plan.batches, plan.maxBatchesThisRequest);
        let allProducts: Product[] = [];
        let previouslyCreated = "";
        let lastMsg = "";

        for (let b = 1; b <= batchCount; b++) {
          const batchPrompt = buildBatchPrompt(
            prompt,
            b,
            plan.batches,
            plan.perBatch,
            plan.categories,
            previouslyCreated
          );

          const { text: batchText, error: batchErr } = await callDeepSeek(
            CREATE_SYSTEM_PROMPT,
            [{ role: "user", content: batchPrompt }],
            batchKey,
            { thinking: false }
          );

          if (!batchText) {
            // If a batch fails mid-way, return what we have so far
            if (allProducts.length > 0) {
              return NextResponse.json({
                products: normalizeProducts(
                  allProducts as unknown as Record<string, unknown>[]
                ) as BrainResponse["products"],
                assistantMessage: `Created ${allProducts.length} of ~${scale.productCount} products before an error stopped batch ${b}. Say "continue" to resume.`,
              });
            }
            return NextResponse.json(
              {
                error: "Batch processing failed",
                message: batchErr || `LLM call failed at batch ${b}`,
              },
              { status: 502 }
            );
          }

          // Parse batch response (raw array format)
          let batchProducts: Product[] = [];
          try {
            const parsed = parseBrainResponse(batchText, true);
            const normalized = normalizeProducts(
              parsed.products as unknown as Record<string, unknown>[]
            );
            batchProducts = normalized as unknown as Product[];
          } catch {
            console.error(
              `[brain] batch ${b} parse failed:`,
              batchText.slice(0, 300)
            );
            // Partial results — return what we have
            if (allProducts.length > 0) {
              const msg =
                progressMsg(
                  b - 1,
                  plan.batches,
                  plan.perBatch,
                  false,
                  allProducts.length
                ) +
                ` (Batch ${b} failed to parse — you have ${allProducts.length} products. Say "continue" to carry on.)`;
              return NextResponse.json({
                products: allProducts as unknown as BrainResponse["products"],
                assistantMessage: msg,
              });
            }
          }

          allProducts = allProducts.concat(batchProducts);
          previouslyCreated = summarizeProducts(batchProducts);

          // Deduplicate by SKU/name
          const seenSku = new Set<string>();
          const seenName = new Set<string>();
          allProducts = allProducts.filter((p) => {
            const key = (p.sku || "") + "|" + (p.name || "");
            if (seenSku.has(p.sku || "") || seenName.has(p.name || "")) {
              return false;
            }
            if (p.sku) seenSku.add(p.sku);
            seenName.add(p.name);
            return true;
          });

          lastMsg = progressMsg(
            b,
            plan.batches,
            plan.perBatch,
            b === plan.batches,
            allProducts.length
          );
          console.log(
            `[brain] batch ${b}/${plan.batches} done: ${batchProducts.length} products (total: ${allProducts.length})`
          );
        }

        const complete = batchCount >= plan.batches;
        const finalMsg =
          (complete ? "" : "⏳ ") +
          lastMsg +
          (complete
            ? ""
            : `\n\nSay **"continue"** or **"more"** to build the remaining ${plan.batches - batchCount} batches.`);

        return NextResponse.json({
          products: dedupeSkus(allProducts) as BrainResponse["products"],
          assistantMessage: finalMsg,
        });
      }

      if (scale.estimatedTokens > 0) {
        console.log(
          "[brain] scale OK:",
          scale.productCount,
          "products, est",
          scale.estimatedTokens,
          "tokens"
        );
      }
    }

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

    let responseData: BrainResponse | undefined;
    try {
      responseData = parseBrainResponse(text, intent === "csv_edit");
    } catch (err: unknown) {
      // RETRY once with a strict-JSON instruction — many "malformed" errors
      // are the model adding commentary or using markdown. A bare retry with
      // an explicit raw-JSON rule fixes most of them without user input.
      let retrySucceeded = false;
      if (deepseekKey) {
        const STRICT_PROMPT =
          "You are a strict JSON generator. Reply with ONLY valid JSON. No markdown code fences, no commentary, no explanation — raw JSON only.";
        const { text: retryText } = await callDeepSeek(
          STRICT_PROMPT,
          turns,
          deepseekKey,
          { thinking: false }
        );
        if (retryText) {
          try {
            responseData = parseBrainResponse(
              retryText,
              intent === "csv_edit"
            );
            retrySucceeded = true;
            text = retryText;
            console.log("[brain] parse retry succeeded");
          } catch (err2: unknown) {
            console.error(
              "[brain] retry parse failed:",
              (retryText || "").slice(0, 500)
            );
          }
        }
      }
      if (!retrySucceeded || !responseData) {
        return NextResponse.json(
          {
            error: "Could not parse model response",
            message:
              err instanceof Error
                ? err.message
                : "Invalid model output",
          },
          { status: 500 }
        );
      }
    }

    if (!responseData) {
      return NextResponse.json(
        { error: "Could not parse model response" },
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
          products: dedupeSkus(currentProducts as Product[]) as BrainResponse["products"],
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

    responseData.products = dedupeSkus(
      responseData.products as unknown as Product[]
    ) as BrainResponse["products"];

    return NextResponse.json(responseData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
