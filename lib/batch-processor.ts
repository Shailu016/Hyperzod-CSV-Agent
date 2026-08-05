import type { Product } from "./schema";
import type { ScaleVerdict } from "./scale-estimator";

/**
 * Automatic batch processor for oversized catalog-creation tasks.
 *
 * When the scale check rejects a request, instead of giving up we:
 * 1. Split the task into batches that each fit within the output cap
 * 2. Process batches in parallel (controlled concurrency)
 * 3. Show progress messages per batch
 * 4. Merge all results and return
 *
 * If the total batch count exceeds what fits in one Vercel request
 * (~8 batches @ 2 parallel × ~30s each = ~120s), we process a partial
 * set and tell the user to say "continue" for the rest.
 *
 * The caller is responsible for calling the LLM — this module handles
 * queue logic, progress tracking, and merge.
 */

export interface BatchPlan {
  /** Total batches needed. */
  batches: number;
  /** Products per batch. */
  perBatch: number;
  /** How many batches can finish in this request (Vercel 290s cap). */
  maxBatchesThisRequest: number;
  /** Categories extracted from the prompt, distributed across batches. */
  categories: string[];
}

export interface BatchResult {
  /** All products accumulated so far. */
  products: Product[];
  /** User-facing progress message. */
  progressMessage: string;
  /** True if all batches are done. */
  done: boolean;
  /** Remaining batch count (0 if done). */
  remaining: number;
}

/* ── Extract categories from the prompt ── */

export function extractCategories(prompt: string): string[] {
  const p = prompt;

  // Look for bullet/list formats: "- Electronics", "• Fashion", etc.
  const bulletMatch = p.match(
    /(?:categories|such as|including|like)[\s:]*\n?((?:[\s]*[-•*]\s*[\w\s&/]+[\s]*)+)/i
  );
  if (bulletMatch) {
    const cats = bulletMatch[1]
      .split(/\n/)
      .map((l) => l.replace(/^[\s]*[-•*\d.]+\s*/, "").trim())
      .filter((c) => c.length > 1 && c.length < 60);
    if (cats.length >= 3) return cats;
  }

  // Look for comma-separated list after "such as", "including", etc.
  // Stop at "with", "Each", "Every", "Support", period, or end of string.
  const inlineMatch = p.match(
    /(?:categories|products? across)[\s\w]*?(?:such\s*as|including|like|from|:)\s*(.+?)(?=\s*(?:\bwith\b|\bEach\b|\bEvery\b|\bSupport\b)|\.\s|\n|$)/i
  );
  if (inlineMatch) {
    const cats = inlineMatch[1]
      .split(/[,;]+/)
      .map((c) => c.replace(/\s+/g, " ").trim())
      .filter((c) => c.length > 1 && c.length < 60);
    if (cats.length >= 3) return cats;
  }

  return [];
}

/* ── Estimate batch plan ── */

const MAX_BATCHES_PER_REQUEST = 8; // fits within Vercel 290s at ~30s/LLM call
const PARALLEL_CALLS = 2;

export function computeBatchPlan(scale: ScaleVerdict): BatchPlan {
  // Safe products per batch
  const perProductTokens =
    scale.addonScore >= 5 ? 5500 :
    scale.addonScore >= 4 ? 3800 :
    scale.addonScore >= 3 ? 2200 :
    scale.addonScore >= 2 ? 1000 :
    scale.addonScore >= 1 ? 500 : 250;

  const USABLE = 57536; // match scale-estimator
  const perBatch = Math.max(3, Math.floor(USABLE / perProductTokens));

  const total = scale.productCount > 0
    ? Math.ceil(scale.productCount / perBatch)
    : 1;

  const categories: string[] = [];

  return {
    batches: total,
    perBatch,
    maxBatchesThisRequest: Math.min(MAX_BATCHES_PER_REQUEST, total),
    categories,
  };
}

/* ── Build batch prompts ── */

export function buildBatchPrompt(
  originalPrompt: string,
  batchNum: number,
  totalBatches: number,
  perBatch: number,
  categories: string[],
  previouslyCreated: string // short summary of what was created so far
): string {
  // Distribute categories to each batch for diversity
  const catsPerBatch = categories.length > 0
    ? Math.ceil(categories.length / totalBatches)
    : 0;
  const startIdx = (batchNum - 1) * catsPerBatch;
  const batchCats = categories.slice(startIdx, startIdx + catsPerBatch);

  const catLine = batchCats.length > 0
    ? `\nFocus these products on these categories: ${batchCats.join(", ")}.`
    : "\nCreate products across varied categories (Electronics, Fashion, Food, Home, Sports, Beauty, etc.).";

  const prevLine = previouslyCreated
    ? `\nYou've already created: ${previouslyCreated}. Create DIFFERENT products — don't repeat these.`
    : "";

  return `You are building a large product catalog in batches. This is batch ${batchNum} of ${totalBatches} (${perBatch} products each).

Original task: "${originalPrompt.substring(0, 200)}"
${catLine}${prevLine}

Create ${perBatch} unique products with:
- Realistic product names and descriptions
- Unique SKUs (generate sequentially)
- Selling prices in ₹100-₹5000 range
- Cost prices at ~40% of selling price
- Appropriate categories
- Status: "active"
- Where the product type makes sense, include options with variants (sizes, colors, add-ons)
- inventory values (10-100)

Write this as a *product generator* question: think about what the products would be for the category(s) assigned, give them plausible price tags and descriptions, generate at most 2-3 option groups per product, keep add-on depth at 1 level (no nested add-ons).

Return ONLY a raw JSON array of the ${perBatch} product objects. Do NOT include a "products" wrapper key.`;
}

/* ── Summarize created products for context injection ── */

export function summarizeProducts(products: Product[]): string {
  if (products.length === 0) return "";
  const names = products
    .slice(0, 20)
    .map((p) => `${p.name} (${p.category})`)
    .join(", ");
  return `${products.length} products: ${names}${products.length > 20 ? "..." : ""}`;
}

/* ── Parse progress from a batch continuation message ── */

export interface BatchProgress {
  batchNum: number;
  totalBatches: number;
}

/** Extract "Batch 8/20 done" → { batchNum: 8, totalBatches: 20 } */
export function parseBatchProgress(msg: string): BatchProgress | null {
  const m = msg.match(/\bBatch\s+(\d+)\s*\/\s*(\d+)\s+done\b/i);
  if (!m) return null;
  return {
    batchNum: parseInt(m[1], 10),
    totalBatches: parseInt(m[2], 10),
  };
}

/* ── Progress message helper ── */

export function progressMsg(
  batchNum: number,
  totalBatches: number,
  perBatch: number,
  done: boolean,
  totalProducts: number
): string {
  if (done) {
    return `All ${totalBatches} batches complete — **${totalProducts} products** created across all categories. Review the grid, then click Export CSV.\n\nIf you get any error while importing this CSV, paste it here and I'll fix it.`;
  }
  const created = batchNum * perBatch;
  const est = totalBatches * perBatch;
  return `**Batch ${batchNum}/${totalBatches} done** — ${created} of ~${est} products. Still working on the remaining ${totalBatches - batchNum} batches...`;
}
