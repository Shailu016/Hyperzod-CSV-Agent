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
            name: "With, comma in name",
            price: 0,
            costPrice: 0,
            inventory: 100,
            description: "line1\nline2 with a, comma and ; semicolon and \"quote\"",
          },
        ],
      },
    ],
  },
];

const csv = generateCSV(products as never);
console.log("--- CSV row 2 ---");
console.log((csv.split(/\r?\n/)[1] || "").slice(0, 400));
console.log("");

const reparsed = parseCSV(csv);
if (reparsed.length !== 1) {
  console.error("FAIL: round-trip lost products");
  process.exit(1);
}
const opts = reparsed[0].options ?? [];
if (opts.length !== 1 || (opts[0].variants || []).length !== 2) {
  console.error("FAIL: round-trip lost variants");
  process.exit(1);
}
const [v1, v2] = opts[0].variants;

const expected1 =
  "An expression of understated luxury. Rose Royale pairs intricate rose gold craftsmanship with sheer elegance, making it a graceful choice for refined.";
if ((v1.description ?? "").trim() !== expected1) {
  console.error("FAIL: v1 description corrupted after round-trip");
  console.error("got: ", v1.description);
  process.exit(1);
}
if (v2.name !== "With, comma in name") {
  console.error("FAIL: v2 name with comma corrupted:", v2.name);
  process.exit(1);
}
if ((v2.description ?? "").indexOf("a, comma and ; semicolon") === -1) {
  console.error("FAIL: v2 description corrupted:", v2.description);
  process.exit(1);
}
if (v1.imageUrl || v2.imageUrl) {
  console.error("FAIL: imageUrl slots polluted:", v1.imageUrl, v2.imageUrl);
  process.exit(1);
}

console.log("PASS: quoted comma descriptions survive round-trip (export + import)");