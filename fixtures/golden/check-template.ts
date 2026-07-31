import { parseCSV } from "../../lib/parser";
import { generateCSV } from "../../lib/generator";
import * as fs from "fs";

const tpl = fs.readFileSync(
  "C:\\Hyperzod_repo\\hyperzod-agentic-csv-studio\\templates\\grocery_store_10_products_multilevel_addons.csv",
  "utf-8"
);
const products = parseCSV(tpl);
console.log("Parsed products:", products.length);
const p0 = products[0];
console.log(
  "Option1:",
  JSON.stringify(p0.options?.[0]?.name),
  "| view:",
  p0.options?.[0]?.view,
  "| variants:",
  p0.options?.[0]?.variants?.length
);
const nested = p0.options?.[0]?.variants?.[0]?.nestedOptions?.[0];
console.log(
  "Nested1:",
  JSON.stringify(nested?.name),
  "| view:",
  nested?.view,
  "| variants:",
  nested?.variants?.length,
  "| range:",
  nested?.range
);
const v = p0.options?.[0]?.variants?.[0];
console.log("Variant field4 (inventory):", v?.inventory);
const regenerated = generateCSV(products);
const p2 = parseCSV(regenerated);
const nested2 = p2[0]?.options?.[0]?.variants?.[0]?.nestedOptions?.[0];
console.log(
  "Round-trip nested view:",
  nested2?.view,
  "| variants:",
  nested2?.variants?.length
);
console.log(
  "Match:",
  nested?.view === nested2?.view &&
    nested?.variants?.length === nested2?.variants?.length
);
