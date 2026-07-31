import type { Product, ProductOption, ProductVariant } from "./schema";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function normalizeVariant(v: Record<string, unknown>): ProductVariant {
  return {
    name: typeof v.name === "string" && v.name.trim() ? v.name : "Variant",
    price: typeof v.price === "number" && isFinite(v.price) ? v.price : 0,
    costPrice:
      typeof v.costPrice === "number" && isFinite(v.costPrice)
        ? v.costPrice
        : undefined,
    inventory:
      typeof v.inventory === "number" && isFinite(v.inventory)
        ? Math.round(v.inventory)
        : typeof v.minQty === "number" && isFinite(v.minQty)
          ? Math.round(v.minQty)
          : 0,
    description:
      typeof v.description === "string" ? v.description : "",
    imageUrl: typeof v.imageUrl === "string" ? v.imageUrl : "",
    nestedOptions: Array.isArray(v.nestedOptions)
      ? v.nestedOptions
          .map(normalizeOption)
          .filter((o: ProductOption) => o.variants.length > 0)
      : [],
  };
}

export function normalizeOption(o: Record<string, unknown>): ProductOption {
  const type = o.type === "multiple" ? "multiple" : "single";
  const rawVariants = Array.isArray(o.variants) ? o.variants : [];
  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name : "Option",
    type,
    enableRange: !!o.enableRange,
    range:
      Array.isArray(o.range) && o.range.length === 2
        ? [Number(o.range[0]) || 0, Number(o.range[1]) || 0]
        : [0, 0],
    required: !!o.required,
    view: o.view === "card" ? "card" : "list",
    variants: rawVariants
      .map(normalizeVariant)
      .filter((v: ProductVariant) => v.name !== "Variant"),
  };
}

export function normalizeProduct(p: Record<string, unknown>): Product {
  const sellingPrice =
    typeof p.sellingPrice === "number" && isFinite(p.sellingPrice)
      ? p.sellingPrice
      : 0;
  const rawCost =
    typeof p.costPrice === "number" && isFinite(p.costPrice)
      ? p.costPrice
      : 0;

  const rawOptions = Array.isArray(p.options) ? p.options : [];

  return {
    id: typeof p.id === "string" && p.id.trim() ? p.id : undefined,
    name:
      typeof p.name === "string" && p.name.trim()
        ? p.name
        : "Untitled Product",
    description: typeof p.description === "string" ? p.description : "",
    sku: typeof p.sku === "string" ? p.sku : "",
    sellingPrice,
    costPrice:
      rawCost > 0 ? round2(rawCost) : round2(sellingPrice * 0.4),
    priceCompare:
      typeof p.priceCompare === "number" && isFinite(p.priceCompare)
        ? p.priceCompare
        : undefined,
    minQty:
      typeof p.minQty === "number" && isFinite(p.minQty)
        ? p.minQty
        : undefined,
    maxQty:
      typeof p.maxQty === "number" && isFinite(p.maxQty)
        ? p.maxQty
        : undefined,
    taxPercent:
      typeof p.taxPercent === "number" && isFinite(p.taxPercent)
        ? p.taxPercent
        : undefined,
    status: p.status === "inactive" ? "inactive" : "active",
    inventory:
      typeof p.inventory === "number" && isFinite(p.inventory)
        ? Math.round(p.inventory)
        : undefined,
    labels: Array.isArray(p.labels)
      ? p.labels.filter((l: unknown) => typeof l === "string")
      : [],
    category:
      typeof p.category === "string" && p.category.trim()
        ? p.category
        : "General",
    tags: Array.isArray(p.tags)
      ? p.tags.filter((t: unknown) => typeof t === "string")
      : [],
    imageUrl: typeof p.imageUrl === "string" ? p.imageUrl : "",
    options: rawOptions
      .map(normalizeOption)
      .filter((o: ProductOption) => o.variants.length > 0),
    _fieldConfidence:
      p._fieldConfidence && typeof p._fieldConfidence === "object"
        ? (p._fieldConfidence as Record<string, "stated" | "inferred">)
        : {},
  };
}

export function normalizeProducts(products: Record<string, unknown>[]): Product[] {
  return products.map(normalizeProduct);
}
