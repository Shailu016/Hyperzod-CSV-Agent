import type { Product, ProductOption, ProductVariant } from "./schema";
import { discoverKey } from "./env";

/**
 * Two-prompt image matching pipeline:
 * 1. Build a stock-photo search query for a menu item (Prompt 1)
 * 2. Grade the top-5 search results and pick the one that genuinely
 *    depicts the item — or reject all (Prompt 2)
 *
 * Fallback rule: primary query → grade; if null → fallback query → grade;
 * if still null → blank or one level up (parent's image). Never settle
 * for "closest available" — that's how a Pepsi can ends up on
 * "Extra Coconutmilk".
 */

const MAX_IMAGE_BYTES = 200_000; // thumbnail-size fetch cap
const IMAGE_TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_RUN = 20;

export interface MatchTarget {
  name: string;
  category: string;
  parentName?: string;
  description?: string;
}

export interface ImageCandidate {
  url: string;
  thumbnail: string;
  alt?: string;
  squareScore?: number;
}

interface SearchQueries {
  primary: string;
  fallback: string;
}

const readEnv = discoverKey;

// ---------------------------------------------------------------------------
// Prompt 1 — build the search query
// ---------------------------------------------------------------------------

const QUERY_BUILDER_PROMPT = `You are writing a search query to find a stock photo of one specific menu item or add-on, to search a royalty-free photo site like Unsplash or Pexels. You'll be given its name, category, and description if available. Output only what's asked — no commentary.

Item: {{item_name}}
Category: {{category}}
Parent product (if this is an add-on): {{parent_product_name}}
Description: {{description}}

Write a short keyword phrase (2-5 words) for exactly this item as a standalone food/product photo — not its category, not a lifestyle scene, not a related brand. Stock sites rank on short keyword phrases better than full sentences: "cheddar cheese slice" beats "a slice of cheddar cheese photographed on a white background."

If it's an add-on, search for the add-on alone — "bacon strips," not "bacon breakfast sandwich" — unless it genuinely can't be shown alone.

Also write one broader fallback phrase, for if the specific one returns nothing usable — e.g. "cheddar cheese" as a fallback for "cheddar cheese slice".

Output as a JSON object exactly like: {"primary": "...", "fallback": "..."}`;

function deterministicQueries(t: MatchTarget): SearchQueries {
  const stopwords = new Set([
    "the", "a", "an", "with", "and", "of", "for", "on", "in", "extra",
    "add", "addon", "add-on", "choice", "option", "side", "serving",
  ]);
  const words = t.name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stopwords.has(w));

  const specific = words.slice(0, 3).join(" ");
  const primary = specific || t.name.toLowerCase().slice(0, 30);
  const fallback = words.slice(0, 2).join(" ") || primary;
  return { primary, fallback };
}

async function buildSearchQueries(t: MatchTarget): Promise<SearchQueries> {
  const apiKey =
    readEnv("GEMINI_API_KEY") || readEnv("LLM_API_KEY") || readEnv("DEEPSEEK_API_KEY");
  const prompt = QUERY_BUILDER_PROMPT
    .replaceAll("{{item_name}}", t.name)
    .replaceAll("{{category}}", t.category || "food")
    .replaceAll("{{parent_product_name}}", t.parentName || "none")
    .replaceAll("{{description}}", t.description || "none");

  if (apiKey) {
    try {
      if (readEnv("DEEPSEEK_API_KEY")) {
        const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${readEnv("DEEPSEEK_API_KEY")}`,
          },
          body: JSON.stringify({
            model: "deepseek-v4-flash",
            messages: [
              { role: "system", content: "You output only JSON." },
              { role: "user", content: prompt },
            ],
            max_tokens: 100,
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) {
          const d = await res.json();
          const text = d.choices?.[0]?.message?.content || "";
          const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
          if (parsed.primary && parsed.fallback) {
            return { primary: String(parsed.primary), fallback: String(parsed.fallback) };
          }
        }
      }
    } catch {
      /* fall through to deterministic */
    }
  }
  return deterministicQueries(t);
}

// ---------------------------------------------------------------------------
// Stock search — keyless Openverse adapter
// (royalty-free CC images from Flickr etc., no API key required)
// ---------------------------------------------------------------------------

async function searchStockImages(query: string): Promise<ImageCandidate[]> {
  try {
    const url =
      `https://api.openverse.org/v1/images/?q=` +
      encodeURIComponent(query) +
      `&page_size=5`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!res.ok) return [];

    const d = await res.json();
    const results: ImageCandidate[] = [];
    for (const r of d.results || []) {
      if (!r.url) continue;
      // Prefer near-square (1:1) images — Hyperzod renders squares by default
      const w = Number(r.width) || 0;
      const h = Number(r.height) || 0;
      const squareScore = w > 0 && h > 0 ? 1 - Math.abs(w - h) / Math.max(w, h) : 0;
      results.push({
        url: r.url,
        thumbnail: r.thumbnail || r.url,
        alt: r.title || undefined,
        squareScore,
      });
    }
    results.sort((a, b) => (b.squareScore ?? 0) - (a.squareScore ?? 0));
    return results.slice(0, 5);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt 2 — grade the candidates (multimodal, via Gemini vision)
// ---------------------------------------------------------------------------

const GRADING_PROMPT = `You are picking which stock photo, if any, correctly represents a specific menu item, out of a set of search results. You'll see up to 5 candidate images and be told what they're supposed to depict.

Item they should show: {{item_name}}
Category: {{category}}
Parent product (if an add-on): {{parent_product_name}}

A candidate only qualifies if its main subject is clearly and specifically this item — not loosely related, not a different item from the same menu, not a lifestyle scene that happens to include it somewhere, not an unrelated object or brand the search engine matched on a stray keyword.

Pick the single best candidate that genuinely qualifies. If none of them do, say so plainly — don't pick the least-bad option just to fill the slot.

Output as a JSON object exactly like: {"selected_index": number or null, "reason": "..."}`;

async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_IMAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    reader.releaseLock();
    const buf = Buffer.concat(chunks);
    return buf.toString("base64");
  } catch {
    return null;
  }
}

async function gradeCandidates(
  t: MatchTarget,
  candidates: ImageCandidate[]
): Promise<{ selectedIndex: number | null; reason: string }> {
  if (candidates.length === 0) return { selectedIndex: null, reason: "No search results" };

  const apiKey = readEnv("GEMINI_API_KEY") || readEnv("LLM_API_KEY");
  if (!apiKey) return { selectedIndex: null, reason: "No vision-capable API key" };

  const prompt = GRADING_PROMPT
    .replaceAll("{{item_name}}", t.name)
    .replaceAll("{{category}}", t.category || "food")
    .replaceAll("{{parent_product_name}}", t.parentName || "none");

  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [
    { text: prompt },
  ];

  // Attach up to 5 candidate thumbnails
  for (const c of candidates.slice(0, 5)) {
    const b64 = await fetchImageAsBase64(c.thumbnail || c.url);
    if (b64) {
      // Gemini auto-detects image format from bytes; jpeg is the safe default
      parts.push({ inlineData: { mimeType: "image/jpeg", data: b64 } });
    }
  }
  if (parts.length < 2) return { selectedIndex: null, reason: "Could not fetch candidate images" };

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const d = await res.json();
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
      const idx = parsed.selected_index;
      return {
        selectedIndex: typeof idx === "number" && idx >= 0 && idx < candidates.length ? idx : null,
        reason: String(parsed.reason || ""),
      };
    }
  } catch {
    /* fall through */
  }
  return { selectedIndex: null, reason: "Grading failed" };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function findBestImage(t: MatchTarget): Promise<string | null> {
  const queries = await buildSearchQueries(t);

  for (const q of [queries.primary, queries.fallback]) {
    const candidates = await searchStockImages(q);
    if (candidates.length === 0) continue;
    const { selectedIndex } = await gradeCandidates(t, candidates);
    if (selectedIndex !== null) {
      return candidates[selectedIndex].url;
    }
  }
  return null;
}

export interface AttachReport {
  matched: number;
  blank: number;
  inherited: number;
  skipped: number;
}

export interface AttachResult {
  products: Product[];
  report: AttachReport;
}

/**
 * Attach images to products and their variants/add-ons.
 * Fallback chain per item: own match → parent's image → blank.
 * Capped at MAX_ITEMS_PER_RUN to stay within function time limits.
 */
export async function attachImages(products: Product[]): Promise<AttachResult> {
  const report: AttachReport = { matched: 0, blank: 0, inherited: 0, skipped: 0 };
  let budget = MAX_ITEMS_PER_RUN;

  const attachTo = async (target: MatchTarget, imageUrl: string | null) => {
    let url = imageUrl;
    if (url) {
      report.matched++;
    } else {
      url = await findBestImage(target);
      if (url) report.matched++;
      else report.blank++;
    }
    return url;
  };

  for (const p of products) {
    if (budget <= 0) {
      report.skipped++;
      continue;
    }
    budget--;

    const productTarget: MatchTarget = {
      name: p.name,
      category: p.category,
      description: p.description,
    };

    // Product-level image
    let productImage = await attachTo(productTarget, p.imageUrl || null);

    // Variants + nested add-ons
    for (const opt of p.options || []) {
      for (const v of opt.variants || []) {
        const variantTarget: MatchTarget = {
          name: v.name,
          category: p.category,
          parentName: p.name,
          description: v.description,
        };
        if (budget <= 0) {
          report.skipped++;
          continue;
        }
        budget--;
        let variantImage = await attachTo(variantTarget, v.imageUrl || null);
        if (!variantImage) {
          variantImage = productImage || "";
          if (variantImage) report.inherited++;
        }
        v.imageUrl = variantImage;

        for (const no of v.nestedOptions || []) {
          for (const sv of no.variants || []) {
            if (budget <= 0) {
              report.skipped++;
              continue;
            }
            budget--;
            const nestedTarget: MatchTarget = {
              name: sv.name,
              category: p.category,
              parentName: p.name,
              description: sv.description,
            };
            let nestedImage = await attachTo(nestedTarget, sv.imageUrl || null);
            if (!nestedImage) {
              nestedImage = variantImage || productImage || "";
              if (nestedImage) report.inherited++;
            }
            sv.imageUrl = nestedImage;
          }
        }
      }
    }
  }

  return { products, report };
}

export function hasImageIntent(prompt: string): boolean {
  return /(add|set|put|give|attach|generate).{0,20}(image|photo|picture|pic)s?|images?\s+(to|for|of)/i.test(prompt) ||
    /(image|photo|picture|pic)s?\b.*\b(add|attach|fill|get|find)/i.test(prompt) ||
    /\bimages\b/i.test(prompt);
}
