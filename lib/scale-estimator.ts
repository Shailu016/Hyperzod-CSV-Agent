import type { SessionState } from "./session";

/**
 * Pre-flight scale check — runs BEFORE any LLM call for csv_create intents.
 *
 * Extracts the requested product count and addon complexity from the
 * prompt, estimates how many output tokens the model would need, and
 * rejects early if the task exceeds the model's output cap.
 *
 * This prevents the "mid-JSON truncation" error (raw truncated text)
 * by catching oversized catalogs at the gate.
 */

export interface ScaleVerdict {
  /** True if the task fits within model output limits. */
  ok: boolean;
  /** Estimated output tokens needed. */
  estimatedTokens: number;
  /** Requested product count from the prompt. */
  productCount: number;
  /** Detected addon complexity score (0-5). */
  addonScore: number;
  /** User-facing message — either confirmation or the reject reason. */
  message: string;
}

/* ── Constants ── */
const OUTPUT_TOKEN_CAP = 65536;
const OVERHEAD_TOKENS = 8000; // system prompt, assistants message, JSON overhead
const USABLE_TOKENS = OUTPUT_TOKEN_CAP - OVERHEAD_TOKENS; // ~57k

// Realistic per-product token estimates based on addon complexity.
// A flat product (no options): ~250 tokens. A product with 4-6 deeply
// nested option groups: ~5000 tokens. These were calibrated against
// actual model output sizes for this codebase.
const TOKENS_PER_PRODUCT: number[] = [
  250,  // score 0 — plain, no options
  500,  // score 1 — 1-2 simple options (size/color)
  1000, // score 2 — 2-3 options with variants
  2200, // score 3 — 3-4 groups, medium nesting
  3800, // score 4 — 4-6 groups, deep nesting
  5500, // score 5 — 6+ groups, 5-level nesting, 20-40 add-ons
];

/* ── Extract product count ── */
function extractProductCount(prompt: string): number {
  const p = prompt.toLowerCase();

  // Patterns where the number is in group 2 (lead word before number)
  const patternsG2 = [
    /\b(exactly|about|around|~|≥)\s*(\d{1,4})\s*(products?|items?|dishes?|entries?)\b/,
    /\b(generate|create|make|build|produce|list)\s+(\d{1,4})\s+(products?|items?|dishes?|pizzas?|burgers?|t-?shirts?|entries?)\b/,
  ];
  for (const re of patternsG2) {
    const m = p.match(re);
    if (m) {
      const n = parseInt(m[2], 10);
      if (n > 0 && n < 10000) return n;
    }
  }

  // Patterns where the number is in group 1 (number comes first)
  const patternsG1 = [
    /\b(\d{1,4})\s*(unique|different|distinct|separate|individual)\s+(products?|items?|entries?)\b/,
    // Allow 1-2 words between the number and noun (e.g. "50 grocery items")
    /\b(\d{1,3})\s+(?:[\w-]+\s+){1,2}(products?|items?|dishes?|entries?)\b/,
    // Tight match: number immediately before noun
    /\b(\d{1,4})\s*(products?|items?|dishes?|entries?)\b/,
  ];
  for (const re of patternsG1) {
    const m = p.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < 10000) return n;
    }
  }

  return 0; // can't determine — let the model decide
}

/* ── Extract option complexity ── */
function extractAddonScore(prompt: string): number {
  const p = prompt.toLowerCase();
  let score = 0;

  // Addon group mentions
  const addonMentions = (p.match(/\b(add[-]?on|nested|option|variant|topping|scoop|sauce|size|cruist|filling)\w*\b/gi) || []).length;
  if (addonMentions >= 15) score = 5;
  else if (addonMentions >= 10) score = 4;
  else if (addonMentions >= 5) score = 3;
  else if (addonMentions >= 2) score = 2;
  else if (addonMentions >= 1) score = 1;

  // Nesting depth
  if (/\b(5|five)[-\s]?levels?\b/i.test(p)) score = Math.max(score, 5);
  else if (/\b(4|four)[-\s]?levels?\b/i.test(p)) score = Math.max(score, 4);
  else if (/\b(3|three)[-\s]?levels?\b/i.test(p)) score = Math.max(score, 3);
  else if (/\b(2|two)[-\s]?levels?\b/i.test(p)) score = Math.max(score, 2);
  else if (/\b(depth|deep|nested|multi[-\s]?level)\b/i.test(p) && score === 0) score = 1;

  // Multiple option groups per product
  const groupCount = (p.match(/\b(add[-]?on groups?|option groups?)\b/gi) || []).length;
  if (groupCount >= 3) score = Math.max(score, 3);

  // Per-product addon count ("20-40 addons each")
  const perProductMatch = p.match(/\b(\d+)[-\s]*(to|and)[-\s]*(\d+)\s*(add[-]?on|option)s?\b/i);
  if (perProductMatch) {
    const high = Math.max(parseInt(perProductMatch[1], 10), parseInt(perProductMatch[3], 10));
    if (high >= 30) score = Math.max(score, 5);
    else if (high >= 15) score = Math.max(score, 4);
  }

  return score;
}

/* ── Extract nesting depth ── */
function extractNestingDepth(prompt: string): number {
  const p = prompt.toLowerCase();
  if (/\b(5|five)[-\s]?levels?\b/i.test(p)) return 5;
  if (/\b(4|four)[-\s]?levels?\b/i.test(p)) return 4;
  if (/\b(3|three)[-\s]?levels?\b/i.test(p)) return 3;
  if (/\b(2|two)[-\s]?levels?\b/i.test(p)) return 2;
  if (/\b(nested|deep|multi[-\s]?level)\b/i.test(p)) return 2;
  return 1; // assume at least flat options
}

export function checkScale(
  prompt: string,
  session: SessionState
): ScaleVerdict {
  const count = extractProductCount(prompt);
  const addonScore = extractAddonScore(prompt);
  const nestingDepth = extractNestingDepth(prompt);

  if (count === 0) {
    // Can't determine count — let it through, model will handle
    return {
      ok: true,
      estimatedTokens: 0,
      productCount: 0,
      addonScore,
      message: "",
    };
  }

  // Estimate: products × per-product-tokens (lookup table, score-clamped)
  const perProductTokens =
    TOKENS_PER_PRODUCT[Math.min(addonScore, TOKENS_PER_PRODUCT.length - 1)];
  const estimatedTokens = count * perProductTokens;

  if (estimatedTokens <= USABLE_TOKENS) {
    return {
      ok: true,
      estimatedTokens,
      productCount: count,
      addonScore,
      message: "",
    };
  }

  // Rejected: suggest a safe batch size
  const safeCount = Math.max(1, Math.floor(USABLE_TOKENS / perProductTokens));
  const suggested = Math.min(safeCount, 15);

  const complexity =
    addonScore >= 4 ? "heavy" : addonScore >= 2 ? "moderate" : "simple";
  const nesting = nestingDepth > 1 ? ` and ${nestingDepth}-level nested add-ons` : "";

  return {
    ok: false,
    estimatedTokens,
    productCount: count,
    addonScore,
    message: `That's too large for one request.

You asked for **${count} products** with ${complexity} add-ons${nesting} — I estimate this needs about **${estimatedTokens.toLocaleString("en-US")} tokens**, but my output cap is ${OUTPUT_TOKEN_CAP.toLocaleString("en-US")} (${USABLE_TOKENS.toLocaleString("en-US")} usable).

**Break it down into smaller prompts.** For example:
- "Create ${suggested} pizza products with toppings and sauces"
- "Create ${suggested} burger products with custom buns and patties"
- "Create ${suggested} coffee products with sizes and add-ons"

I can handle about 10-15 products with full add-ons per prompt. For 200 products, that's roughly 15-20 prompts.`,
  };
}
