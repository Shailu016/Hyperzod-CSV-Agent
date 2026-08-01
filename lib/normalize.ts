import type { Product, ProductOption, ProductVariant } from "./schema";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Max nesting depth for options inside variants (Hyperzod confirmed: 2, allowed: 3). */
export const MAX_NESTED_DEPTH = 3;

function isValidUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") return trimmed;
  } catch {
    /* not a URL */
  }
  return "";
}

export function normalizeVariant(
  v: Record<string, unknown>,
  parentType?: "single" | "multiple",
  depth = 1
): ProductVariant {
  const nestedOptions = Array.isArray(v.nestedOptions)
    ? v.nestedOptions
        .map((o: Record<string, unknown>) => normalizeOption(o, depth + 1))
        .filter((o: ProductOption) => o.variants.length > 0)
    : [];
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
    imageUrl: isValidUrl(v.imageUrl),
    // Hyperzod: MULTIPLE options must NOT have child options
    nestedOptions:
      parentType === "multiple" || depth >= MAX_NESTED_DEPTH ? [] : nestedOptions,
  };
}

export function normalizeOption(
  o: Record<string, unknown>,
  depth = 1
): ProductOption {
  const rawType = typeof o.type === "string" ? o.type.toLowerCase() : "single";
  const type = rawType === "multiple" ? "multiple" : "single";
  const rawView = typeof o.view === "string" ? o.view.toLowerCase() : "list";
  const rawVariants = Array.isArray(o.variants) ? o.variants : [];
  const toBool = (v: unknown): boolean =>
    v === true || v === "yes" || v === "YES" || v === "Yes" || v === "true" || v === "1";
  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name : "Option",
    type,
    enableRange: toBool(o.enableRange),
    range:
      Array.isArray(o.range) && o.range.length === 2
        ? [Number(o.range[0]) || 0, Number(o.range[1]) || 0]
        : [0, 0],
    required: toBool(o.required),
    view: rawView === "card" ? "card" : "list",
    variants: rawVariants
      .map((v: Record<string, unknown>) => normalizeVariant(v, type, depth))
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
    imageUrl: isValidUrl(p.imageUrl),
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
