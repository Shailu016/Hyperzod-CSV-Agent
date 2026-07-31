import type { Product, ProductOption, ProductVariant } from "./schema";

/**
 * Quote-aware CSV parser. Handles:
 * - quoted fields containing commas, quotes ("" escapes), and newlines
 * - UTF-8 BOM
 * - CRLF / LF line endings
 */
function parseCsvToRows(csvText: string): Record<string, string>[] {
  let text = csvText;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && next === "\n") i++;
      record.push(field);
      field = "";
      records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  // Drop empty trailing rows
  while (
    records.length > 0 &&
    records[records.length - 1].every((c) => c.trim() === "")
  ) {
    records.pop();
  }

  if (records.length < 2) return [];

  const headers = records[0];
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < records.length; r++) {
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = (records[r][c] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
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

/**
 * Find the position of the variant list's opening "(" that belongs to an
 * option's metadata — i.e. the LAST top-level "(" after the view token.
 * Robust against "list" appearing inside option/variant names.
 */
function findVariantsParen(inner: string): { parenIdx: number; endIdx: number } {
  // The variants paren is the last '(' ... ')' pair at top level (no nesting inside options).
  let parenIdx = -1;
  let endIdx = -1;
  for (let i = inner.length - 1; i >= 0; i--) {
    if (inner[i] === ")") {
      endIdx = i;
      // walk back to matching "("
      let depth = 0;
      for (let j = i; j >= 0; j--) {
        if (inner[j] === ")") depth++;
        else if (inner[j] === "(") {
          depth--;
          if (depth === 0) {
            parenIdx = j;
            break;
          }
        }
      }
      break;
    }
  }
  return { parenIdx, endIdx };
}

/**
 * Quote-aware single-line split. Needed because the nested option meta
 * contains quoted ranges with commas: `name,single,no,"[0,1]",yes,list`.
 */
function splitQuoted(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      tokens.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  tokens.push(current.trim());
  return tokens;
}

function parseNestedOption(rawText: string): ProductOption | null {
  const text = rawText.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;

  const inner = text.slice(1, -1).trim();
  const { parenIdx, endIdx } = findVariantsParen(inner);
  if (parenIdx === -1 || endIdx === -1) return null;

  const metaPart = inner.slice(0, parenIdx).trim();
  const variantsPart = inner.slice(parenIdx + 1, endIdx).trim();

  // Meta tokens: name,type,enableRange,range,required,view
  const metaTokens = splitQuoted(metaPart);

  const name = metaTokens[0] || "Option";
  const type = (metaTokens[1] || "single").toLowerCase() as
    | "single"
    | "multiple";
  const enableRange = (metaTokens[2] || "no").toLowerCase() === "yes";

  let range: [number, number] = [0, 0];
  const rawRange = (metaTokens[3] || "0,0").replace(/[\[\]"]/g, "");
  const rangeParts = rawRange.split(",");
  if (rangeParts.length === 2) {
    range = [parseInt(rangeParts[0], 10) || 0, parseInt(rangeParts[1], 10) || 0];
  }

  const required = (metaTokens[4] || "no").toLowerCase() === "yes";
  const viewRaw = (metaTokens[5] || "").toLowerCase().trim();
  const view = (viewRaw === "card" ? "card" : "list") as "list" | "card";

  const variantStrings = splitVariants(variantsPart);
  const variants: ProductVariant[] = [];
  for (const vs of variantStrings) {
    const v = parseVariantString(vs);
    if (v) variants.push(v);
  }

  return { name, type, enableRange, range, required, view, variants };
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

  const tokens = working.split(",").map((t: string) => t.trim());
  if (tokens.length === 0 || !tokens[0]) return null;

  return {
    name: tokens[0],
    price: parseFloat(tokens[1]) || 0,
    costPrice: parseFloat(tokens[2]) || undefined,
    inventory: parseInt(tokens[3], 10) || 0,
    description: tokens[4] ?? "",
    imageUrl: tokens[5] ?? "",
    nestedOptions: nestedOptions.length > 0 ? nestedOptions : undefined,
  };
}

function parseOptionRow(
  row: Record<string, string>,
  index: number
): ProductOption | null {
  const nameKey = `OPTION${index}.NAME`;
  if (!row[nameKey]) return null;

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
    name: row[nameKey],
    type: (row[`OPTION${index}.TYPE`] || "SINGLE").toLowerCase() as
      | "single"
      | "multiple",
    enableRange:
      (row[`OPTION${index}.ENABLE_RANGE`] || "NO").toUpperCase() === "YES",
    range,
    required:
      (row[`OPTION${index}.REQUIRED`] || "NO").toUpperCase() === "YES",
    view: (row[`OPTION${index}.VIEW`] || "LIST").toLowerCase() as
      | "list"
      | "card",
    variants,
  };
}

export function parseCSV(csvText: string): Product[] {
  const rows = parseCsvToRows(csvText);
  const products: Product[] = [];

  for (const row of rows) {
    const name = row["PRODUCT.NAME"];
    if (!name) continue;

    const minMaxStr = row["PRODUCT.MIN.MAX.QUANTITY"] || "";
    const minMaxParts = minMaxStr ? minMaxStr.split(",") : [];

    const options: ProductOption[] = [];
    // Don't break on the first missing column — sparse option columns are valid (B16)
    for (let i = 1; i <= 100; i++) {
      const opt = parseOptionRow(row, i);
      if (opt) options.push(opt);
    }

    const costCell = parseFloat(row["PRODUCT.PRICE.COST"] || "0");
    const product: Product = {
      name,
      description: row["PRODUCT.DESCRIPTION"] || "",
      sku: row["PRODUCT.SKU"] || "",
      sellingPrice: parseFloat(row["PRODUCT.PRICE.SELLING"] || "0") || 0,
      costPrice: costCell > 0 ? costCell : undefined,
      priceCompare:
        parseFloat(row["PRODUCT.PRICE.COMPARE"] || "0") || undefined,
      minQty:
        minMaxParts.length >= 1
          ? parseInt(minMaxParts[0], 10) || undefined
          : undefined,
      maxQty:
        minMaxParts.length >= 2
          ? parseInt(minMaxParts[1], 10) || undefined
          : undefined,
      taxPercent: parseFloat(row["PRODUCT.TAX_PERCENT"] || "0") || undefined,
      status: (row["PRODUCT.STATUS"] || "active").toLowerCase() as
        | "active"
        | "inactive",
      inventory: parseInt(row["PRODUCT.INVENTORY"] || "0", 10) || undefined,
      labels: (row["PRODUCT.LABELS"] || "")
        .split(",")
        .map((l: string) => l.trim())
        .filter(Boolean),
      category: row["PRODUCT.CATEGORY"] || "",
      tags: (row["PRODUCT.TAGS"] || "")
        .split(",")
        .map((t: string) => t.trim())
        .filter(Boolean),
      imageUrl: row["PRODUCT.IMAGES"] || "",
      options,
      _fieldConfidence: {},
    };

    products.push(product);
  }

  return products;
}
