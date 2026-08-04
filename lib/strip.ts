import type { Product } from "./schema";

/** Cap on how many products are sent to the LLM at once. */
export const MAX_PRODUCTS_TO_LLM = 100;

/**
 * Summarize products for the LLM. Two modes:
 *   compact — names, prices, variant names/prices only. Used for simple
 *             targeted edits: the merge layer preserves everything we
 *             omit (longer-text-wins / numeric-changes-only), so the
 *             model never sees (or accidentally echoes) what it shouldn't.
 *   full    — everything including descriptions, images, nested add-ons.
 *             Used for complex/structural tasks that need full visibility.
 */
export function stripForLLM(
  products: Product[],
  mode: "compact" | "full" = "full"
): Record<string, unknown>[] {
  return products.slice(0, MAX_PRODUCTS_TO_LLM).map((p) => {
    const c: Record<string, unknown> = {
      name: p.name,
      sellingPrice: p.sellingPrice,
      category: p.category,
      status: p.status,
    };
    if (p.id) c.id = p.id;
    if (p.sku) c.sku = p.sku;
    if (p.costPrice != null) c.costPrice = p.costPrice;
    if (p.inventory != null) c.inventory = p.inventory;
    if (mode === "full") {
      if (p.description) c.description = p.description;
      if (p.imageUrl) c.imageUrl = p.imageUrl;
      if (p.labels?.length) c.labels = p.labels;
      if (p.tags?.length) c.tags = p.tags;
    }
    if (p.options?.length) {
      c.options = p.options.map((o) => {
        const opt: Record<string, unknown> = {
          name: o.name,
          type: o.type,
        };
        if (mode === "full") {
          opt.enableRange = o.enableRange;
          opt.range = o.range;
          opt.required = o.required;
          opt.view = o.view;
        }
        opt.variants = o.variants.map((v) => {
          const variant: Record<string, unknown> = {
            name: v.name,
            price: v.price,
            costPrice: v.costPrice,
            inventory: v.inventory,
          };
          if (mode === "full") {
            if (v.description) variant.description = v.description;
            if (v.imageUrl) variant.imageUrl = v.imageUrl;
            variant.nestedOptions = (v.nestedOptions ?? []).map((n) => ({
              name: n.name,
              type: n.type,
              enableRange: n.enableRange,
              range: n.range,
              required: n.required,
              view: n.view,
              variants: n.variants.map((sv) => ({
                name: sv.name,
                price: sv.price,
                costPrice: sv.costPrice,
                inventory: sv.inventory,
                description: sv.description ?? "",
                imageUrl: sv.imageUrl ?? "",
              })),
            }));
          }
          return variant;
        });
        return opt;
      });
    }
    return c;
  });
}
