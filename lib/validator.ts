import type { Product } from "./schema";

export interface ValidationIssue {
  rowIndex: number;
  field: string;
  message: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  valid: boolean;
  warningCount: number;
  errorCount: number;
}

export function validateProducts(products: Product[]): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const skuSet = new Set<string>();
  const skuRows = new Map<string, number>();

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const row = i + 1;

    if (!p.name || p.name.trim().length === 0) {
      errors.push({ rowIndex: i, field: "name", message: "Product name is required" });
    }

    if (p.sellingPrice == null || p.sellingPrice === 0) {
      errors.push({ rowIndex: i, field: "sellingPrice", message: "Selling price is required" });
    }

    if (isNaN(p.sellingPrice)) {
      errors.push({ rowIndex: i, field: "sellingPrice", message: "Selling price must be a number" });
    }

    if (p.costPrice == null || p.costPrice <= 0) {
      errors.push({
        rowIndex: i,
        field: "costPrice",
        message: "Cost price is required by Hyperzod",
      });
    }

    for (let oi = 0; oi < (p.options ?? []).length; oi++) {
      const opt = p.options![oi];
      if (!opt.variants || opt.variants.length === 0) {
        warnings.push({
          rowIndex: i,
          field: `options[${oi}]`,
          message: `Option "${opt.name}" has no variants — it will be dropped from the export`,
        });
      }
    }

    if (!p.category || p.category.trim().length === 0) {
      errors.push({ rowIndex: i, field: "category", message: "Category is required" });
    }

    if (
      p.priceCompare != null &&
      p.priceCompare > 0 &&
      p.priceCompare <= p.sellingPrice
    ) {
      errors.push({
        rowIndex: i,
        field: "priceCompare",
        message: `Compare price (${p.priceCompare}) must be greater than selling price (${p.sellingPrice})`,
      });
    }

    if (p.minQty != null && p.maxQty != null && p.minQty > p.maxQty) {
      errors.push({
        rowIndex: i,
        field: "minQty",
        message: `Min quantity (${p.minQty}) must be <= max quantity (${p.maxQty})`,
      });
    }

    if (p.taxPercent != null && p.taxPercent < 0) {
      errors.push({
        rowIndex: i,
        field: "taxPercent",
        message: "Tax percent must be positive",
      });
    }

    if (p.imageUrl) {
      try {
        const url = new URL(p.imageUrl);
        if (url.protocol === "http:") {
          warnings.push({
            rowIndex: i,
            field: "imageUrl",
            message: `Image URL uses HTTP — Hyperzod may require HTTPS: ${p.imageUrl}`,
          });
        }
      } catch {
        errors.push({
          rowIndex: i,
          field: "imageUrl",
          message: `Image URL is not a valid URL: ${p.imageUrl}`,
        });
      }
    }

    if (!["active", "inactive"].includes(p.status)) {
      errors.push({
        rowIndex: i,
        field: "status",
        message: `Status must be "active" or "inactive", got "${p.status}"`,
      });
    }

    if (p.sku && p.sku.trim()) {
      const sku = p.sku.trim().toLowerCase();
      if (skuSet.has(sku)) {
        const otherRow = skuRows.get(sku);
        errors.push({
          rowIndex: i,
          field: "sku",
          message: `SKU "${p.sku}" is duplicated (also in row ${otherRow != null ? otherRow + 1 : "?"})`,
        });
      } else {
        skuSet.add(sku);
        skuRows.set(sku, i);
      }
    }

    // Validate nested option/variant brace balance
    validateBraceBalance(p, i, errors);
  }

  return {
    errors,
    warnings,
    valid: errors.length === 0,
    errorCount: errors.length,
    warningCount: warnings.length,
  };
}

function validateBraceBalance(
  product: Product,
  rowIndex: number,
  errors: ValidationIssue[]
) {
  for (let optIdx = 0; optIdx < (product.options ?? []).length; optIdx++) {
    const opt = product.options![optIdx];
    for (let vIdx = 0; vIdx < (opt.variants ?? []).length; vIdx++) {
      const v = opt.variants[vIdx];
      const nested = v.nestedOptions ?? [];

      for (let nIdx = 0; nIdx < nested.length; nIdx++) {
        const no = nested[nIdx];
        const variantStr = (no.variants ?? [])
          .map((sv: { name: string }) => sv.name)
          .join("");

        const braceDiff =
          (variantStr.match(/\{/g)?.length ?? 0) -
          (variantStr.match(/\}/g)?.length ?? 0) +
          (no.name.match(/\{/g)?.length ?? 0) -
            (no.name.match(/\}/g)?.length ?? 0);

        if (braceDiff !== 0) {
          errors.push({
            rowIndex,
            field: `options[${optIdx}].variants[${vIdx}].nestedOptions[${nIdx}]`,
            message: "Unbalanced braces in nested option — import will fail",
          });
        }
      }
    }
  }
}
