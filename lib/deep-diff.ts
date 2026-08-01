import type { Product, ProductOption, ProductVariant } from "./schema";

/**
 * Recursive structural diff between two product lists.
 * Used after an LLM edit to find every field that changed, so the
 * caller can revert anything that wasn't authorized by the user.
 */

export interface DiffEntry {
  /** Index of the product in the list */
  productIndex: number;
  /** Human-readable path, e.g. "options[0].variants[1].nestedOptions[0].variants[2].price" */
  path: string;
  /** Authorized-agnostic: the top-level field or "options" if inside an option */
  rootField: string;
  before: unknown;
  after: unknown;
}

function normalizeForDiff(v: unknown): unknown {
  if (typeof v === "number") return Math.round(v * 100) / 100;
  return v;
}

function diffVariants(
  before: ProductVariant[],
  after: ProductVariant[],
  pathPrefix: string,
  productIndex: number,
  out: DiffEntry[]
): void {
  const beforeByName = new Map(before.map((v) => [v.name, v]));
  const afterByName = new Map(after.map((v) => [v.name, v]));

  for (const b of before) {
    const a = afterByName.get(b.name);
    if (!a) {
      out.push({ productIndex, path: `${pathPrefix} (variant "${b.name}")`, rootField: "options", before: b, after: undefined });
      continue;
    }
    for (const field of ["price", "costPrice", "inventory", "description", "imageUrl"] as const) {
      const bv = normalizeForDiff(b[field]);
      const av = normalizeForDiff(a[field]);
      if (JSON.stringify(bv) !== JSON.stringify(av)) {
        out.push({
          productIndex,
          path: `${pathPrefix}/${field} (variant "${b.name}")`,
          rootField: "options",
          before: bv,
          after: av,
        });
      }
    }
    // Recurse into nested options
    diffNested(b.nestedOptions || [], a.nestedOptions || [], `${pathPrefix}/nested (variant "${b.name}")`, productIndex, out);
  }

  // Variants that only exist in "after" (added) — not a violation, but report
  for (const a of after) {
    if (!beforeByName.has(a.name)) {
      out.push({ productIndex, path: `${pathPrefix} (new variant "${a.name}")`, rootField: "options", before: undefined, after: a });
    }
  }
}

function diffNested(
  before: ProductOption[],
  after: ProductOption[],
  pathPrefix: string,
  productIndex: number,
  out: DiffEntry[]
): void {
  const beforeByName = new Map(before.map((o) => [o.name, o]));
  const afterByName = new Map(after.map((o) => [o.name, o]));

  for (const b of before) {
    const a = afterByName.get(b.name);
    if (!a) {
      out.push({ productIndex, path: `${pathPrefix} (nested option "${b.name}" removed)`, rootField: "options", before: b, after: undefined });
      continue;
    }
    diffVariants(b.variants || [], a.variants || [], `${pathPrefix}/${b.name}`, productIndex, out);
  }
  for (const a of after) {
    if (!beforeByName.has(a.name)) {
      out.push({ productIndex, path: `${pathPrefix} (nested option "${a.name}" added)`, rootField: "options", before: undefined, after: a });
    }
  }
}

function diffOptions(
  before: ProductOption[],
  after: ProductOption[],
  productIndex: number,
  out: DiffEntry[]
): void {
  const beforeByName = new Map(before.map((o) => [o.name, o]));
  const afterByName = new Map(after.map((o) => [o.name, o]));

  for (const b of before) {
    const a = afterByName.get(b.name);
    if (!a) {
      out.push({ productIndex, path: `options (option "${b.name}" removed)`, rootField: "options", before: b, after: undefined });
      continue;
    }
    if (b.type !== a.type) {
      out.push({ productIndex, path: `options/${b.name}.type`, rootField: "options", before: b.type, after: a.type });
    }
    diffVariants(b.variants || [], a.variants || [], `options/${b.name}`, productIndex, out);
  }
  for (const a of after) {
    if (!beforeByName.has(a.name)) {
      out.push({ productIndex, path: `options (option "${a.name}" added)`, rootField: "options", before: undefined, after: a });
    }
  }
}

/** Diff two product lists. Products matched by id || sku || name || index. */
export function deepDiffProducts(beforeList: Product[], afterList: Product[]): DiffEntry[] {
  const out: DiffEntry[] = [];

  for (let i = 0; i < beforeList.length; i++) {
    const b = beforeList[i];
    const a = afterList[i] || (afterList.find((x) => (x.id && x.id === b.id) || (x.sku && x.sku === b.sku) || x.name === b.name) as Product | undefined);
    if (!a) {
      out.push({ productIndex: i, path: "product", rootField: "product", before: b, after: undefined });
      continue;
    }

    const topFields: (keyof Product)[] = [
      "name", "description", "sku", "sellingPrice", "costPrice", "priceCompare",
      "minQty", "maxQty", "taxPercent", "status", "inventory", "labels", "category", "tags", "imageUrl",
    ];
    for (const field of topFields) {
      const bv = normalizeForDiff(b[field]);
      const av = normalizeForDiff(a[field]);
      if (JSON.stringify(bv) !== JSON.stringify(av)) {
        out.push({ productIndex: i, path: String(field), rootField: String(field), before: bv, after: av });
      }
    }

    diffOptions(b.options || [], a.options || [], i, out);
  }

  // Products that appear only in after (added) — report as additions
  for (let i = beforeList.length; i < afterList.length; i++) {
    out.push({ productIndex: i, path: "product (new)", rootField: "product", before: undefined, after: afterList[i] });
  }

  return out;
}

/** Restore the given entries to their original values in the afterList. */
export function restoreEntries(afterList: Product[], entries: DiffEntry[]): Product[] {
  const result = JSON.parse(JSON.stringify(afterList)) as Product[];

  for (const e of entries) {
    if (e.before === undefined) continue; // additions are kept
    const product = result[e.productIndex];
    if (!product) continue;

    // Top-level product field
    const topMatch = e.path.match(/^(name|description|sku|sellingPrice|costPrice|priceCompare|minQty|maxQty|taxPercent|status|inventory|labels|category|tags|imageUrl)$/);
    if (topMatch) {
      (product as unknown as Record<string, unknown>)[topMatch[1]] = e.before;
      continue;
    }

    // Option/variant/nested paths — restore by name-matching on each segment
    if (e.path.startsWith("options")) {
      // Check DEEPEST (nested) paths first — they also match the
      // shallower variant regex if the field name collides.
      const nestedMatch = e.path.match(/^options\/(.+?)\/nested \(variant "(.+?)"\)\/(.+?)\/(.+?) \(variant "(.+?)"\)$/);
      if (nestedMatch) {
        const [, optName, variantName, nestedName, field, subVariantName] = nestedMatch;
        const opt = product.options?.find((o) => o.name === optName);
        const variant = opt?.variants.find((v) => v.name === variantName);
        const nested = variant?.nestedOptions?.find((n) => n.name === nestedName);
        const subVariant = nested?.variants.find((v) => v.name === subVariantName);
        if (subVariant && field in subVariant) {
          (subVariant as unknown as Record<string, unknown>)[field] = e.before;
        }
        continue;
      }

      const optMatch = e.path.match(/^options\/(.+?)\/(price|costPrice|inventory|description|imageUrl) \(variant "(.+?)"\)$/);
      if (optMatch) {
        const [, optName, field, variantName] = optMatch;
        const opt = product.options?.find((o) => o.name === optName);
        const variant = opt?.variants.find((v) => v.name === variantName);
        if (variant && field in variant) {
          (variant as unknown as Record<string, unknown>)[field] = e.before;
        }
        continue;
      }
      // Removed option/variant/nested-option — re-add from before
      const removedOpt = e.path.match(/^options \(option "(.+?)" removed\)$/);
      if (removedOpt) {
        product.options = product.options || [];
        if (e.before && typeof e.before === "object") {
          product.options.push(e.before as ProductOption);
        }
        continue;
      }
      const removedVariant = e.path.match(/^options\/(.+?) \(variant "(.+?)" removed\)$/);
      if (removedVariant) {
        const [, optName, variantName] = removedVariant;
        const opt = product.options?.find((o) => o.name === optName);
        if (opt && e.before && typeof e.before === "object") {
          opt.variants = opt.variants || [];
          opt.variants.push(e.before as ProductVariant);
        }
        continue;
      }
      const removedNested = e.path.match(/^options\/(.+?)\/nested \(variant "(.+?)"\) \(nested option "(.+?)" removed\)$/);
      if (removedNested) {
        const [, optName, variantName, nestedName] = removedNested;
        const opt = product.options?.find((o) => o.name === optName);
        const variant = opt?.variants.find((v) => v.name === variantName);
        if (variant && e.before && typeof e.before === "object") {
          variant.nestedOptions = variant.nestedOptions || [];
          variant.nestedOptions.push(e.before as ProductOption);
        }
        continue;
      }
    }
  }

  return result;
}
