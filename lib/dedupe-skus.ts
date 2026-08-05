import type { Product } from "./schema";

const SKU_RE = /^([A-Za-z]+?)(\d+)$/;

export function dedupeSkus(products: Product[]): Product[] {
  const used = new Set<string>();
  const byPrefix = new Map<string, number>();

  return products.map((p) => {
    const sku = (p.sku ?? "").trim();
    if (!sku) return p;

    const key = sku.toUpperCase();
    if (!used.has(key)) {
      used.add(key);
      return p;
    }

    const match = sku.match(SKU_RE);
    if (match) {
      const prefix = match[1].toUpperCase();
      let next = byPrefix.get(prefix) ?? NaN;
      if (isNaN(next)) next = parseInt(match[2], 10) + 1;
      let candidate = `${prefix}${String(next).padStart(3, "0")}`;
      while (used.has(candidate)) {
        next++;
        candidate = `${prefix}${String(next).padStart(3, "0")}`;
      }
      byPrefix.set(prefix, next + 1);
      used.add(candidate);
      return { ...p, sku: candidate };
    }

    let n = 2;
    let cand = `${sku}-${n}`;
    while (used.has(cand.toUpperCase())) {
      n++;
      cand = `${sku}-${n}`;
    }
    used.add(cand.toUpperCase());
    return { ...p, sku: cand };
  });
}