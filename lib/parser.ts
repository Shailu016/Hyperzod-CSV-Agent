import type { Product, ProductOption, ProductVariant } from "./schema";

function parseCsvToRows(csvText: string): Record<string, string>[] {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function parseNestedOption(rawText: string): ProductOption | null {
  const text = rawText.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;

  const inner = text.slice(1, -1).trim();
  const listIdx = inner.toLowerCase().lastIndexOf("list");
  if (listIdx === -1) return null;

  const metaPart = inner.slice(0, listIdx).trim();
  const afterList = inner.slice(listIdx + 4).trim();

  const parenStart = afterList.indexOf("(");
  const parenEnd = afterList.lastIndexOf(")");
  if (parenStart === -1 || parenEnd === -1) return null;

  const variantsPart = afterList.slice(parenStart + 1, parenEnd).trim();

  const metaTokens = parseCSVLine(metaPart).map((t: string) => t.trim());

  const name = metaTokens[0] ?? "Option";
  const type = (metaTokens[1] ?? "single").toLowerCase() as "single" | "multiple";
  const enableRange = (metaTokens[2] ?? "no").toLowerCase() === "yes";
  let range: [number, number] = [0, 0];

  const rawRange = (metaTokens[3] ?? "0,0").replace(/[\[\]"]/g, "");
  const rangeParts = rawRange.split(",");
  if (rangeParts.length === 2) {
    range = [parseInt(rangeParts[0], 10) || 0, parseInt(rangeParts[1], 10) || 0];
  }

  const required = (metaTokens[4] ?? "no").toLowerCase() === "yes";
  const view = (metaTokens[5] ?? "list").toLowerCase() as "list" | "card";

  const variantStrings = splitVariants(variantsPart);
  const variants: ProductVariant[] = [];

  for (const vs of variantStrings) {
    const v = parseVariantString(vs);
    if (v) variants.push(v);
  }

  return {
    name,
    type,
    enableRange,
    range,
    required,
    view,
    variants,
  };
}

function splitVariants(field: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let braceDepth = 0;

  for (const char of field) {
    if (char === "{") {
      braceDepth++;
      current += char;
    } else if (char === "}") {
      if (braceDepth > 0) braceDepth--;
      current += char;
    } else if (char === ";" && braceDepth === 0) {
      chunks.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function parseVariantString(text: string): ProductVariant | null {
  let working = text.trim();
  const nestedOptions: ProductOption[] = [];

  while (working.includes("{") && working.includes("}")) {
    const startIdx = working.indexOf("{");
    const endIdx = working.indexOf("}", startIdx);
    if (startIdx !== -1 && endIdx !== -1) {
      const nestedStr = working.slice(startIdx, endIdx + 1);
      const parsed = parseNestedOption(nestedStr);
      if (parsed) nestedOptions.push(parsed);
      working = (working.slice(0, startIdx) + working.slice(endIdx + 1)).trim();
    } else {
      break;
    }
  }

  const tokens = parseCSVLine(working).map((t: string) => t.trim());

  if (tokens.length === 0 || !tokens[0]) return null;

  return {
    name: tokens[0],
    price: parseFloat(tokens[1]) || 0,
    costPrice: parseFloat(tokens[2]) || 0,
    minQty: parseInt(tokens[3], 10) || 0,
    description: tokens[4] ?? "",
    imageUrl: tokens[5] ?? "",
    nestedOptions: nestedOptions.length > 0 ? nestedOptions : undefined,
  };
}

function parseOptionRow(row: Record<string, string>, index: number): ProductOption | null {
  const nameKey = `OPTION${index}.NAME`;
  if (!row[nameKey] || !row[nameKey].trim()) return null;

  const rawRange = (row[`OPTION${index}.RANGE`] || "").replace(/[\[\]"]/g, "");
  const rangeParts = rawRange.split(",");
  const range: [number, number] = [
    parseInt(rangeParts[0], 10) || 0,
    parseInt(rangeParts[1], 10) || 0,
  ];

  const variantsRaw = row[`OPTION${index}.VARIANTS`] || "";
  const variantStrings = splitVariants(variantsRaw);
  const variants: ProductVariant[] = [];

  for (const vs of variantStrings) {
    const v = parseVariantString(vs);
    if (v) variants.push(v);
  }

  return {
    name: row[nameKey].trim(),
    type: (row[`OPTION${index}.TYPE`] || "SINGLE").toLowerCase() as "single" | "multiple",
    enableRange: (row[`OPTION${index}.ENABLE_RANGE`] || "NO").toUpperCase() === "YES",
    range,
    required: (row[`OPTION${index}.REQUIRED`] || "NO").toUpperCase() === "YES",
    view: (row[`OPTION${index}.VIEW`] || "LIST").toLowerCase() as "list" | "card",
    variants,
  };
}

export function parseCSV(csvText: string): Product[] {
  const rows = parseCsvToRows(csvText);
  const products: Product[] = [];

  for (const row of rows) {
    const name = (row["PRODUCT.NAME"] || "").trim();
    if (!name) continue;

    const minMaxStr = (row["PRODUCT.MIN.MAX.QUANTITY"] || "").trim();
    const minMaxParts = minMaxStr ? minMaxStr.split(",") : [];

    const options: ProductOption[] = [];
    for (let i = 1; i <= 100; i++) {
      const opt = parseOptionRow(row, i);
      if (opt) {
        options.push(opt);
      } else {
        break;
      }
    }

    const product: Product = {
      name,
      description: (row["PRODUCT.DESCRIPTION"] || "").trim(),
      sku: (row["PRODUCT.SKU"] || "").trim(),
      sellingPrice: parseFloat(row["PRODUCT.PRICE.SELLING"] || "0") || 0,
      costPrice: parseFloat(row["PRODUCT.PRICE.COST"] || "0") || 0,
      priceCompare: parseFloat(row["PRODUCT.PRICE.COMPARE"] || "0") || undefined,
      minQty: minMaxParts.length >= 1 ? parseInt(minMaxParts[0], 10) || undefined : undefined,
      maxQty: minMaxParts.length >= 2 ? parseInt(minMaxParts[1], 10) || undefined : undefined,
      taxPercent: parseFloat(row["PRODUCT.TAX_PERCENT"] || "0") || undefined,
      status: (row["PRODUCT.STATUS"] || "active").toLowerCase() as "active" | "inactive",
      inventory: parseInt(row["PRODUCT.INVENTORY"] || "0", 10) || undefined,
      labels: (row["PRODUCT.LABELS"] || "").split(",").map((l: string) => l.trim()).filter(Boolean),
      category: (row["PRODUCT.CATEGORY"] || "").trim(),
      tags: (row["PRODUCT.TAGS"] || "").split(",").map((t: string) => t.trim()).filter(Boolean),
      imageUrl: (row["PRODUCT.IMAGES"] || "").trim(),
      options,
      _fieldConfidence: {},
    };

    products.push(product);
  }

  return products;
}
