import type { Product, ProductOption, ProductVariant } from "./schema";

/**
 * Smart product merge for patch-style edits.
 *
 * The model returns only the products it CHANGED. This function merges
 * them onto the originals with a safety-first policy. Key invariants:
 *
 *   1. LONG TEXT (descriptions) — never truncate. Original wins unless
 *      the model's version is LONGER (a genuine edit).
 *   2. NUMBERS (price/cost/inventory) — apply model's value when it
 *      differs; numbers don't truncate, so a change is intentional.
 *   3. ARRAYS (labels/tags) — empty from model = omitted = preserve
 *      original. Only replace when model's array is non-empty.
 *   4. OPTIONS — preserve originals the model didn't touch; update by
 *      name; add genuinely new ones.
 *   5. RENAME — match by id → sku → name → INDEX (same-position
 *      fallback), so renames never create duplicates.
 *   6. New options replicated to all products ONLY when
 *      replicateNewOptions is true (catalog-wide instruction).
 */

export interface MergeResult {
  products: Product[];
  addedOptions: number;
  updatedOptions: number;
  preservedOptions: number;
}

function isLongerText(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.length > b.length;
}

function numChanged(mv: unknown, ov: unknown): boolean {
  return (
    typeof mv === "number" &&
    (typeof ov !== "number" || mv !== ov)
  );
}

export function mergeProducts(
  originals: Product[],
  changes: Product[],
  removeAuthorized: boolean,
  replicateNewOptions = false
): MergeResult {
  let addedOptions = 0;
  let updatedOptions = 0;
  let preservedOptions = 0;

  // Phase 1: collect new option names from the changes (for replication)
  const newOptionNames = new Set<string>();
  const originalOptionNames = new Set(
    originals.flatMap((p) => (p.options || []).map((o) => o.name))
  );
  for (const c of changes) {
    for (const o of c.options || []) {
      if (!originalOptionNames.has(o.name)) {
        newOptionNames.add(o.name);
      }
    }
  }

  // Grab one copy of each new option for replication to other products
  const newOptionTemplates = new Map<string, ProductOption>();
  for (const c of changes) {
    for (const o of c.options || []) {
      if (newOptionNames.has(o.name) && !newOptionTemplates.has(o.name)) {
        newOptionTemplates.set(o.name, JSON.parse(JSON.stringify(o)));
      }
    }
  }

  // Index fallback for rename-without-id: match by position as a last resort.
  const consumedChanges = new Set<number>();
  const findMatch = (orig: Product, idx: number): Product | undefined => {
    let m = changes.find((c, ci) => c.id && c.id === orig.id && !consumedChanges.has(ci) && (consumedChanges.add(ci), true));
    if (m) return m;
    m = changes.find((c, ci) => c.sku && c.sku === orig.sku && !consumedChanges.has(ci) && (consumedChanges.add(ci), true));
    if (m) return m;
    m = changes.find((c, ci) => c.name === orig.name && !consumedChanges.has(ci) && (consumedChanges.add(ci), true));
    if (m) return m;
    // Positional fallback: only when counts match, so renames without id
    // still resolve without double-appending
    if (changes.length === originals.length && !consumedChanges.has(idx)) {
      consumedChanges.add(idx);
      return changes[idx];
    }
    return undefined;
  };

  const merged: Product[] = originals.map((orig, idx) => {
    const match = findMatch(orig, idx);

    if (!match) {
      // No match for this product — replicate new options only when
      // the instruction is catalog-wide.
      if (replicateNewOptions && newOptionNames.size > 0 && !removeAuthorized) {
        const existingNames = new Set((orig.options || []).map((o) => o.name));
        const toAdd: ProductOption[] = [];
        for (const [name, tmpl] of newOptionTemplates) {
          if (!existingNames.has(name)) {
            toAdd.push(JSON.parse(JSON.stringify(tmpl)));
            addedOptions++;
          }
        }
        return { ...orig, options: [...(orig.options || []), ...toAdd] };
      }
      preservedOptions += (orig.options || []).length;
      return orig;
    }

    // Non-option fields: apply model's values with safety rules
    const result: Product = { ...orig };

    // Text fields: original wins unless model's is longer (genuine edit)
    if (isLongerText(match.name, orig.name)) result.name = match.name!;
    else if (match.name && match.name !== orig.name) result.name = match.name;
    if (isLongerText(match.description, orig.description)) result.description = match.description!;

    // Numeric fields: apply when present
    if (match.sellingPrice != null) result.sellingPrice = match.sellingPrice;
    if (match.costPrice != null) result.costPrice = match.costPrice;
    if (match.priceCompare != null) result.priceCompare = match.priceCompare;
    if (match.minQty != null) result.minQty = match.minQty;
    if (match.maxQty != null) result.maxQty = match.maxQty;
    if (match.taxPercent != null) result.taxPercent = match.taxPercent;
    if (match.inventory != null) result.inventory = match.inventory;

    // Enums / strings: apply when provided
    if (match.status) result.status = match.status;
    if (match.category) result.category = match.category;
    if (match.imageUrl) result.imageUrl = match.imageUrl;
    if (match.sku) result.sku = match.sku;
    if (match.id) result.id = match.id;

    // Array fields: empty = omitted = preserve
    if (Array.isArray(match.labels) && match.labels.length > 0) result.labels = match.labels;
    if (Array.isArray(match.tags) && match.tags.length > 0) result.tags = match.tags;
    if (match._fieldConfidence) result._fieldConfidence = match._fieldConfidence;

    // Options: safety-first merge
    if (removeAuthorized) {
      result.options = match.options ?? orig.options;
    } else {
      const originalByName = new Map((orig.options || []).map((o) => [o.name, o]));
      const mergedOptions = (orig.options || []).map((o) => JSON.parse(JSON.stringify(o)));
      const mergedByName = new Map(mergedOptions.map((o) => [o.name, o]));

      for (const mo of match.options || []) {
        const existing = mergedByName.get(mo.name);
        if (existing) {
          // Update existing option
          if (mo.type) existing.type = mo.type;
          if (mo.enableRange !== undefined) existing.enableRange = mo.enableRange;
          if (mo.range) existing.range = mo.range;
          if (mo.required !== undefined) existing.required = mo.required;
          if (mo.view) existing.view = mo.view;

          // Variants: preserve original details unless the model's version
          // is LONGER text or a DIFFERENT number (intentional edits)
          const origVByName = new Map<string, ProductVariant>((existing.variants || []).map((v: ProductVariant) => [v.name, v]));
          const mergedVariants: ProductVariant[] = (existing.variants || []).map((v: ProductVariant) => JSON.parse(JSON.stringify(v)) as ProductVariant);
          const mergedVByName = new Map<string, ProductVariant>(mergedVariants.map((v) => [v.name, v]));

          for (const mv of mo.variants || []) {
            const ov = mergedVByName.get(mv.name);
            if (ov) {
              // Numeric: apply when changed
              if (numChanged(mv.price, ov.price)) ov.price = mv.price!;
              if (numChanged(mv.costPrice, ov.costPrice)) ov.costPrice = mv.costPrice;
              if (numChanged(mv.inventory, ov.inventory)) ov.inventory = mv.inventory!;
              // Text: longer wins
              if (isLongerText(mv.description, ov.description)) ov.description = mv.description;
              if (isLongerText(mv.imageUrl, ov.imageUrl)) ov.imageUrl = mv.imageUrl;
              // Nested options: recurse-preserve
              if (mv.nestedOptions && mv.nestedOptions.length > 0) {
                const existingNested = new Map<string, ProductOption>((ov.nestedOptions || []).map((n) => [n.name, n]));
                const mergedNested: ProductOption[] = (ov.nestedOptions || []).map((n) => JSON.parse(JSON.stringify(n)));
                for (const mn of mv.nestedOptions) {
                  if (existingNested.has(mn.name)) {
                    // preserve nested variants (same rules)
                    const en = existingNested.get(mn.name)!;
                    const nOrigV = new Map<string, ProductVariant>((en.variants || []).map((v) => [v.name, v]));
                    for (const nv of mn.variants || []) {
                      const no = nOrigV.get(nv.name);
                      if (no) {
                        if (numChanged(nv.price, no.price)) no.price = nv.price!;
                        if (isLongerText(nv.description, no.description)) no.description = nv.description;
                      } else {
                        en.variants.push(JSON.parse(JSON.stringify(nv)));
                      }
                    }
                  } else {
                    mergedNested.push(JSON.parse(JSON.stringify(mn)));
                  }
                }
                ov.nestedOptions = mergedNested;
              }
            } else {
              // genuinely new variant from the model — add it
              mergedVariants.push(JSON.parse(JSON.stringify(mv)));
            }
          }
          existing.variants = mergedVariants;
          updatedOptions++;
        } else {
          // New option — track for replication
          mergedOptions.push(JSON.parse(JSON.stringify(mo)));
          addedOptions++;
        }
      }
      result.options = mergedOptions;
      preservedOptions += (orig.options || []).length;
    }

    // Replicate new options to this matched product only when catalog-wide
    if (replicateNewOptions && newOptionNames.size > 0 && !removeAuthorized) {
      const existingNames = new Set((result.options || []).map((o) => o.name));
      const toAdd: ProductOption[] = [];
      for (const [name, tmpl] of newOptionTemplates) {
        if (!existingNames.has(name)) {
          toAdd.push(JSON.parse(JSON.stringify(tmpl)));
          addedOptions++;
        }
      }
      result.options = [...(result.options || []), ...toAdd];
    }

    return result;
  });

  // Append genuinely new products (no match by id/sku/name/index)
  const existingKeys = new Set(
    merged.map((m) => `${m.id ?? ""}|${m.sku ?? ""}|${m.name}`)
  );
  for (let ci = 0; ci < changes.length; ci++) {
    if (consumedChanges.has(ci)) continue; // already merged into an original
    const c = changes[ci];
    const key = `${c.id ?? ""}|${c.sku ?? ""}|${c.name}`;
    if (!existingKeys.has(key)) {
      merged.push(c);
      existingKeys.add(key);
      addedOptions += (c.options || []).length;
    }
  }

  return { products: merged, addedOptions, updatedOptions, preservedOptions };
}
