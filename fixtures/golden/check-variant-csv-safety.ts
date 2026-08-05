import { generateCSV } from "../../lib/generator";
import { parseCSV } from "../../lib/parser";

const products = [
  {
    name: "Oud Kuwaiti",
    sellingPrice: 289,
    costPrice: 230,
    category: "Attars- 6 ml",
    status: "active",
    options: [
      {
        name: "Pick Your Bottle (3 ml)",
        type: "single",
        enableRange: false,
        range: [0, 0],
        required: false,
        view: "list",
        variants: [
          {
            name: "Rose Royale",
            price: 0,
            costPrice: 0,
            inventory: 100,
            description:
              "An expression of understated luxury. Rose Royale pairs intricate rose gold craftsmanship with sheer elegance, making it a graceful choice for refined.",
          },
          {
            name: "Imperfect, {broken} ; text",
            price: 0,
            costPrice: 0,
            inventory: 100,
            description: "line1\nline2 with a, comma and ; semicolon",
          },
        ],
      },
    ],
  },
];

const csv = generateCSV(products as never);
console.log("--- CSV row 2 (first 350 chars) ---");
console.log((csv.split(/\r?\n/)[1] || "").slice(0, 350));
console.log("");

const reparsed = parseCSV(csv);
if (reparsed.length !== 1) {
  console.error("FAIL: round-trip lost products");
  process.exit(1);
}

const opts = reparsed[0].options ?? [];
if (opts.length !== 1 || (opts[0].variants || []).length !== 2) {
  console.error("FAIL: round-trip lost variants:", JSON.stringify(opts, null, 1));
  process.exit(1);
}
const [v1, v2] = opts[0].variants;

for (const v of [v1, v2]) {
  // Longest text is the description field (position 4) — a correct parse
  // means the comma/semicolon-heavy text stayed in the description slot.
  const fields = [v.name, String(v.price), String(v.costPrice ?? ""), String(v.inventory ?? ""), v.description ?? "", v.imageUrl ?? ""];
  if (fields.length !== 6) {
    console.error("FAIL: unexpected field count", fields);
    process.exit(1);
  }
}

console.log("v1.description:", (v1.description ?? "").slice(0, 60), "...");
console.log("v2.name:", v2.name);
console.log("v2.description:", v2.description ?? "");
console.log("PASS: comma/semicolon text stays inside its field after round-trip");