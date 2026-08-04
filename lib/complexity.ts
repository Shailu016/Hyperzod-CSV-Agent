import type { Product } from "./schema";
import type { SessionState } from "./session";

/**
 * Complexity judge — a cheap, deterministic classifier that decides how
 * the brain should spend its intelligence on each task:
 *
 *   simple  → thinking OFF (explicitly disabled), compact context  → fast & cheap
 *   complex → thinking ON (reasoning_effort high), full context   → slow & smart
 *
 * No LLM call is spent on this — it is pure scoring, so the decision is
 * instant and free.
 */

export type ComplexityTier = "simple" | "complex";
export type ContextMode = "compact" | "full";

export interface ComplexityVerdict {
  tier: ComplexityTier;
  /** Enable model chain-of-thought for this turn. */
  thinking: boolean;
  /** How much product detail to send to the model. */
  context: ContextMode;
  score: number;
  reasons: string[];
}

const FIELD_WORDS = [
  "price", "prices", "cost", "inventory", "stock", "status", "active",
  "inactive", "category", "name", "rename", "description", "desc", "sku",
  "label", "labels", "tag", "tags", "image", "photo", "picture", "tax",
  "gst", "minqty", "maxqty",
];

const CONDITIONAL_RE =
  /\b(if|unless|except|except for|but not|only for|only the|keep|leave|preserve|skip|exclude|without changing|don'?t (touch|change|modify))\b/i;

const SCOPE_RE = /\b(all|every|each|entire|whole|both|any|catalog)\b/i;

const OPTION_RE =
  /\b(option|options|variant|variants|add-?on|add-?ons|nested|topping|toppings|scoop|scoops|flavou?rs?|colou?rs?|sizes?)\b/i;

const PCT_RE =
  /\b(increase|decrease|raise|lower|cut|reduce|hike|mark|make|set|change|add|by)\b[^%]{0,50}%|\d%/i;

const RANGE_RE = /\b(between|from .* to|range of)\b/i;

const REMOVE_OPTION_RE =
  /\b(remove|delete|drop|cut)\b.{0,20}\b(option|variant|add-?on|addon)\b|\b(option|variant|add-?on|addon)\b.{0,20}\b(remove|delete|drop)\b/i;

const RICH_CONTEXT_RE =
  /\b(description|desc|details|image|images|photo|photos|picture|pictures|pic|pics|label|labels|tag|tags|nested|add-?ons?)\b/i;

export function judgeComplexity(
  prompt: string,
  session: SessionState,
  products: Product[],
  intent: "csv_edit" | "csv_create"
): ComplexityVerdict {
  const p = prompt.trim();
  let score = 0;
  const reasons: string[] = [];

  if (CONDITIONAL_RE.test(p)) {
    score += 3;
    reasons.push("conditional/exclusion language");
  }

  if (SCOPE_RE.test(p)) {
    score += 2;
    reasons.push("catalog-wide scope");
  }

  if (OPTION_RE.test(p)) {
    score += 2;
    reasons.push("options/variants involved");
  }

  const fieldHits = new Set<string>();
  for (const w of FIELD_WORDS) {
    if (new RegExp(`\\b${w}\\b`, "i").test(p)) fieldHits.add(w);
  }
  if (fieldHits.size >= 2) {
    score += 2;
    reasons.push(`${fieldHits.size} fields targeted`);
  }

  if (PCT_RE.test(p)) {
    score += 2;
    reasons.push("percentage arithmetic");
  }

  if (RANGE_RE.test(p)) {
    score += 2;
    reasons.push("value range");
  }

  const numbers = p.match(/\b(?:₹|rs\.?|inr|usd|€|£)?\s?\d{1,4}(?:\.\d+)?/gi) || [];
  const distinctNumbers = new Set(
    numbers.map((n) => n.replace(/\D/g, "")).filter(Boolean)
  );
  if (distinctNumbers.size >= 3) {
    score += 1;
    reasons.push("multiple distinct values");
  }

  if (REMOVE_OPTION_RE.test(p)) {
    score += 1;
    reasons.push("destructive option removal");
  }

  const clauses = p.split(/[.,;]/).filter((c) => c.trim().length > 2);
  if (clauses.length >= 3) {
    score += 2;
    reasons.push(`${clauses.length} clauses`);
  } else if (/\b(and also|then|additionally|plus|as well)\b/i.test(p)) {
    score += 1;
    reasons.push("compound instruction");
  }

  if (session.continuation) {
    score += 1;
    reasons.push("follow-up on earlier task");
  }

  if (products.length > 20) {
    score += 1;
    reasons.push(`${products.length} products loaded`);
  }

  if (session.catalogDepth >= 2) {
    score += 1;
    reasons.push("nested add-ons in catalog");
  }

  if (intent === "csv_create") {
    const m = p
      .toLowerCase()
      .match(
        /\b(\d{1,3})\s+(?:[\w-]+\s+){0,3}(products?|items?|dishes?|t-?shirts?|pizzas?|burgers?|bottles?|packs?|groceries|add-?ons?)\b/
      );
    if (m && parseInt(m[1], 10) > 5) {
      score += 3;
      reasons.push(`${m[1]} products to create`);
    }
  }

  const tier: ComplexityTier = score >= 5 ? "complex" : "simple";
  const needsRichContext =
    tier === "complex" || RICH_CONTEXT_RE.test(p);

  return {
    tier,
    thinking: tier === "complex",
    context: needsRichContext ? "full" : "compact",
    score,
    reasons,
  };
}
