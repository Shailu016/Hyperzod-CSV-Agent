import type { Product } from "./schema";

/**
 * Edit authorization — determines WHICH product fields the user's
 * instruction is allowed to change. Everything else is protected:
 * after the LLM edits, any change to a non-authorized field is reverted.
 */

export interface EditAuthorization {
  /** True if any field keyword was found */
  hasFieldTarget: boolean;
  /** Authorized product-level field names */
  fields: Set<string>;
  /** Authorized option/variant operations (e.g. "variant", "addon") */
  touchesOptions: boolean;
  /** Clear natural-language summary for the report */
  summary: string;
  /** Why we can't proceed (when hasFieldTarget is false) */
  reason?: string;
}

/** Levenshtein distance — typo tolerance for keyword matching. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Words that tolerate a 1-2 char typo when matching keywords. */
function fuzzyWordMatches(word: string, targets: string[]): boolean {
  const w = word.toLowerCase();
  for (const t of targets) {
    const dist = levenshtein(w, t);
    // allow 1 typo for short words, 2 for longer ones
    const maxDist = t.length <= 5 ? 1 : 2;
    if (dist <= maxDist && w.length >= t.length - 2) return true;
  }
  return false;
}

/** Hinglish / regional synonyms mapped to canonical field targets. */
const HINGLISH_SYNONYMS: [string[], string][] = [
  [["price", "prices", "daam", "dam", "rate", "rates", "pricing", "qimat", "kimat", "bhav", "bhaav"], "sellingPrice"],
  [["cost", "costprice", "lagaat", "costprice", "kharid"], "costPrice"],
  [["mrp", "compareprice", "strikeprice", "originalprice", "markprice"], "priceCompare"],
  [["inventory", "stock", "units", "stok", "maldar", "maldar"], "inventory"],
  [["minqty", "minquantity", "minqty", "kamsekam"], "minQty"],
  [["maxqty", "maxquantity", "zyada", "zyadasezyada"], "maxQty"],
  [["status", "active", "inactive", "visibility", "live", "publish", "sathi"], "status"],
  [["name", "title", "rename", "naam", "nam"], "name"],
  [["description", "desc", "details", "varnan", "about"], "description"],
  [["sku", "skus", "code", "codes", "codee"], "sku"],
  [["category", "categories", "type", "section", "shreni", "category"], "category"],
  [["label", "labels", "badge", "merchandis", "merchandising"], "labels"],
  [["tag", "tags", "keyword", "keywords", "searchterm", "searchterms"], "tags"],
  [["image", "images", "photo", "photos", "picture", "pictures", "pic", "pics", "img", "tasveer", "photo"], "imageUrl"],
  [["tax", "gst", "taxpercent"], "taxPercent"],
];

/** Hinglish option-related words. */
const HINGLISH_OPTION_WORDS = [
  "option", "options", "variant", "variants", "addon", "addons", "add-on", "add-ons",
  "topping", "toppings", "scoop", "scoops", "choice", "choices", "suboption", "suboptions",
  "size", "sizes", "flavor", "flavors", "flavour", "flavours", "color", "colors", "colour", "colours",
  "pack", "packs", "adons", "addonss", "option", "variants",
  "addan", "addans", "vaiyant", "vaariyant",
];

/** Check if a token is an option-related word (typo tolerant). */
function isOptionWord(token: string): boolean {
  const w = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!w || w.length < 3) return false;
  if (HINGLISH_OPTION_WORDS.includes(w)) return true;
  return fuzzyWordMatches(w, HINGLISH_OPTION_WORDS);
}

/** Map a token to a canonical field, typo tolerant. */
function mapTokenToField(token: string): string | null {
  const w = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!w) return null;
  for (const [words, field] of HINGLISH_SYNONYMS) {
    if (words.includes(w)) return field;
    if (fuzzyWordMatches(w, words)) return field;
  }
  return null;
}

const FIELD_KEYWORDS: [RegExp, string, string][] = [
  [/\b(selling ?price|price|prices|rate|pricing|rates)\b/i, "sellingPrice", "prices"],
  [/\b(cost ?price|cost ?prices|cost)\b/i, "costPrice", "cost prices"],
  [/\b(compare ?price|mrp|strike ?price|original ?price)\b/i, "priceCompare", "compare prices"],
  [/\b(inventory|stock|quantity on hand|units)\b/i, "inventory", "inventory"],
  [/\b(min(imum)? ?qty|min ?quantity)\b/i, "minQty", "min quantities"],
  [/\b(max(imum)? ?qty|max ?quantity)\b/i, "maxQty", "max quantities"],
  [/\b(status|active|inactive|visibility|live|publish)\b/i, "status", "status"],
  [/\b(name|title|product name|rename)\b/i, "name", "names"],
  [/\b(description|desc|details|about)\b/i, "description", "descriptions"],
  [/\b(sku|skus|sku ?number|code|codes)\b/i, "sku", "SKUs"],
  [/\b(categor(y|ies)|type|section)\b/i, "category", "categories"],
  [/\b(label|badge|merchandis)\b/i, "labels", "labels"],
  [/\b(tag|keyword|search ?term)\b/i, "tags", "tags"],
  [/\b(image|photo|picture|pic|img)\b/i, "imageUrl", "images"],
  [/\b(tax|gst)\b/i, "taxPercent", "tax"],
];

const OPTION_KEYWORDS: RegExp[] = [
  /\b(option|options|variant|variants|add-?on|add-?ons|addon|addons|topping|toppings|scoop|scoops|sub-?option|sub-?options|choice|choices)\b/i,
  /\b(size|sizes|flavor|flavors|flavour|flavours|color|colours?|colour|colours|pack|packs)\b/i,
];

/** Extract the authorized edit surface from an instruction. */
export function authorizeEdit(prompt: string): EditAuthorization {
  const fields = new Set<string>();
  const matched: string[] = [];

  for (const [re, field, label] of FIELD_KEYWORDS) {
    if (re.test(prompt)) {
      fields.add(field);
      matched.push(label);
    }
  }

  // Hinglish / typo-tolerant token-level matching
  const tokens = prompt.toLowerCase().split(/[\s,.;:!?'"()]+/);
  for (const token of tokens) {
    const field = mapTokenToField(token);
    if (field && !fields.has(field)) {
      fields.add(field);
      matched.push(field);
    }
    if (!matched.some((m) => m.includes("options")) && isOptionWord(token)) {
      // mark options touched via the flag below
    }
  }
  const touchesOptions =
    OPTION_KEYWORDS.some((re) => re.test(prompt)) ||
    tokens.some(isOptionWord);

  if (fields.size === 0 && !touchesOptions) {
    return {
      hasFieldTarget: false,
      fields,
      touchesOptions,
      summary: "",
      reason:
        "I couldn't tell which field to change. Say what to change, e.g. 'set inventory to 10' or 'increase all prices by 10%'.",
    };
  }

  const summary =
    (fields.size > 0 ? matched.join(", ") : "") +
    (touchesOptions ? (fields.size > 0 ? ", " : "") + "options/variants" : "");

  return { hasFieldTarget: true, fields, touchesOptions, summary };
}

/**
 * LLM-based field resolution — used when regex + Hinglish matching fail.
 * Handles typos, other languages, and context ("price badhao", "updte adons").
 * Returns a field name or null if genuinely unresolvable.
 */
export async function resolveFieldTargetLLM(
  prompt: string,
  apiKey: string
): Promise<string | null> {
  const ALLOWED = [
    "sellingPrice", "costPrice", "priceCompare", "inventory", "minQty", "maxQty",
    "status", "name", "description", "sku", "category", "labels", "tags",
    "imageUrl", "taxPercent", "options",
  ];

  const sys = `The user wants to edit products in a catalog. Their instruction may have typos or be in another language (e.g. Hinglish).
Which product field are they trying to change? Reply with ONLY one word from this list, or "unknown" if you can't tell:
${ALLOWED.join(", ")}
Examples:
- "price badhao" -> sellingPrice
- "updte adons" -> options
- "stok set karo" -> inventory
- "photos change" -> imageUrl`;

  try {
    const url = `https://api.deepseek.com/v1/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: prompt },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const text = (d.choices?.[0]?.message?.content || "")
      .trim()
      .toLowerCase();
    if (ALLOWED.includes(text)) return text;
    // fuzzy-match the reply to allowed list
    for (const a of ALLOWED) {
      if (levenshtein(text, a) <= 1) return a;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Deterministic numeric operations detected from an instruction.
 * These are computed in code — never left to the model.
 */
export interface NumericOp {
  targetField: "sellingPrice" | "costPrice" | "priceCompare" | "inventory";
  op: "set" | "increase_pct" | "decrease_pct";
  value: number; // set: absolute value; pct: percentage (e.g. 10 for 10%)
}

const NUMERIC_PATTERNS: { re: RegExp; target: NumericOp["targetField"] }[] = [
  {
    re: /(?:set|make|change|update).{0,20}(?:selling ?price|price|rate).{0,10}(?:to|=|:)?\s*(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)/i,
    target: "sellingPrice",
  },
  {
    re: /(?:set|make|change|update).{0,20}(?:cost ?price|cost).{0,10}(?:to|=|:)?\s*(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)/i,
    target: "costPrice",
  },
  {
    re: /(?:set|make|change|update).{0,20}(?:inventory|stock).{0,10}(?:to|=|:)?\s*(\d+)/i,
    target: "inventory",
  },
];

const PCT_PATTERNS: { re: RegExp; op: NumericOp["op"]; target: NumericOp["targetField"] }[] = [
  {
    re: /(increase|raise|hike|add).{0,30}(?:selling ?price|price|prices|rate|rates).{0,20}?(\d+(?:\.\d+)?)\s*%/i,
    op: "increase_pct",
    target: "sellingPrice",
  },
  {
    re: /(decrease|reduce|lower|cut|discount).{0,30}(?:selling ?price|price|prices|rate|rates).{0,20}?(\d+(?:\.\d+)?)\s*%/i,
    op: "decrease_pct",
    target: "sellingPrice",
  },
  {
    re: /(increase|raise|hike).{0,30}(?:cost ?price|cost ?prices).{0,20}?(\d+(?:\.\d+)?)\s*%/i,
    op: "increase_pct",
    target: "costPrice",
  },
  {
    re: /(decrease|reduce|lower|cut).{0,30}(?:cost ?price|cost ?prices).{0,20}?(\d+(?:\.\d+)?)\s*%/i,
    op: "decrease_pct",
    target: "costPrice",
  },
  {
    re: /(increase|raise|hike).{0,30}(?:inventory|stock).{0,20}?(\d+(?:\.\d+)?)\s*%/i,
    op: "increase_pct",
    target: "inventory",
  },
  {
    re: /(decrease|reduce|lower|cut).{0,30}(?:inventory|stock).{0,20}?(\d+(?:\.\d+)?)\s*%/i,
    op: "decrease_pct",
    target: "inventory",
  },
];

export function extractNumericOps(prompt: string): NumericOp[] {
  const ops: NumericOp[] = [];

  for (const { re, target } of NUMERIC_PATTERNS) {
    const m = prompt.match(re);
    if (m) {
      const value = parseFloat(m[1]);
      if (!isNaN(value)) ops.push({ targetField: target, op: "set", value });
    }
  }

  for (const { re, op, target } of PCT_PATTERNS) {
    const m = prompt.match(re);
    if (m) {
      const value = parseFloat(m[2]);
      if (!isNaN(value)) ops.push({ targetField: target, op, value });
    }
  }

  return ops;
}

/** Apply a numeric op deterministically to a product. Returns new product. */
export function applyNumericOp(p: Product, op: NumericOp): Product {
  const current = p[op.targetField];
  let next: number | undefined;

  if (op.op === "set") {
    next = op.value;
  } else {
    const base = typeof current === "number" ? current : 0;
    const factor = op.op === "increase_pct" ? 1 + op.value / 100 : 1 - op.value / 100;
    next = op.targetField === "inventory"
      ? Math.round(base * factor)
      : Math.round(base * factor * 100) / 100;
  }

  return { ...p, [op.targetField]: next };
}
