import { normalizeProduct } from "../../lib/normalize";

const cases: Array<{ label: string; input: Record<string, unknown> }> = [
  {
    label: "string price + string cost",
    input: { name: "A", sellingPrice: "199", costPrice: "99", category: "T" },
  },
  {
    label: "currency-formatted",
    input: { name: "B", sellingPrice: "₹1,299", costPrice: "Rs. 599", category: "T" },
  },
  {
    label: "missing price (should stay 0)",
    input: { name: "C", category: "T" },
  },
  {
    label: "zero prices (should stay 0)",
    input: { name: "D", sellingPrice: 0, costPrice: 0, category: "T" },
  },
  {
    label: "numeric variant price",
    input: {
      name: "E",
      sellingPrice: 500,
      costPrice: 200,
      category: "T",
      options: [{ name: "Size", variants: [{ name: "M", price: "50", costPrice: "25" }] }],
    },
  },
];

for (const c of cases) {
  const p = normalizeProduct(c.input);
  console.log(
    `${c.label.padEnd(30)} selling=${p.sellingPrice} cost=${p.costPrice} opts=${p.options.length}`
  );
}

const a = normalizeProduct(cases[0].input);
if (a.sellingPrice !== 199 || a.costPrice !== 99) {
  console.error("FAIL: string prices not coerced");
  process.exit(1);
}
const b = normalizeProduct(cases[1].input);
if (b.sellingPrice !== 1299 || b.costPrice !== 599) {
  console.error("FAIL: currency strings not coerced", b.sellingPrice, b.costPrice);
  process.exit(1);
}
const d = normalizeProduct(cases[3].input);
if (d.sellingPrice !== 0 || d.costPrice !== 0) {
  console.error("FAIL: zero prices corrupted", d.sellingPrice, d.costPrice);
  process.exit(1);
}
const e = normalizeProduct(cases[4].input);
if (e.options[0]?.variants[0]?.price !== 50 || e.options[0]?.variants[0]?.costPrice !== 25) {
  console.error("FAIL: variant string prices not coerced");
  process.exit(1);
}
console.log("PASS: numeric coercion works (numbers + strings + currency)");