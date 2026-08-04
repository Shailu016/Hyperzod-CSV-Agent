import type { Product, ChatMessage } from "../../lib/schema";

const BASE = "http://localhost:3000";

const catalog: Product[] = [
  {
    id: "p1",
    name: "Oud Kuwaiti",
    description: "<p>A deep smoky Arabian oud with resinous notes and a long-lasting trail.</p>",
    sellingPrice: 45,
    costPrice: 20,
    inventory: 5,
    category: "Attars",
    status: "active",
    options: [
      {
        name: "Box",
        type: "single",
        enableRange: false,
        range: [0, 1],
        required: true,
        view: "list",
        variants: [
          { name: "6 ml", price: 0, inventory: 100, description: "Pocket-size roll-on" },
          { name: "12 ml", price: 4, inventory: 100, description: "Mid-size bottle" },
        ],
      },
    ],
  },
  {
    id: "p2",
    name: "Rose Attar",
    description: "<p>Fresh damask rose distilled into a pure oil.</p>",
    sellingPrice: 39,
    costPrice: 18,
    inventory: 3,
    category: "Attars",
    status: "active",
  },
];

const history: ChatMessage[] = [
  { role: "user", content: "Add a Choose Your Box category to all products" },
  {
    role: "assistant",
    content:
      "Done — 2 products updated with 1 option group and 2 variants. Review the grid, then click Export CSV.",
  },
];

async function call(prompt: string, extra: Partial<{ products: Product[]; history: ChatMessage[] }> = {}) {
  const res = await fetch(`${BASE}/api/brain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      currentProducts: extra.products ?? catalog,
      history: extra.history ?? [],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status}: ${err.message || err.error || JSON.stringify(err)}`);
  }
  return res.json();
}

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  } else {
    console.log(`  ok: ${name}`);
  }
}

async function main(): Promise<void> {
console.log("=== Live: COMPLEX task (thinking ON, full context) ===");
const complexPrompt =
  "add a Gift Box option to both products with 3 variants at 10/20/30, and keep the existing descriptions untouched";
const complex = await call(complexPrompt, { history });
check("response parsed (has products array)", Array.isArray(complex.products), JSON.stringify(complex.products).slice(0, 300));
check("both products returned/updated", complex.products.length >= 2, String(complex.products.length));
const p1 = complex.products.find((p: Product) => p.id === "p1");
const giftBox = p1?.options?.find((o: { name?: string }) => o.name === "Gift Box");
check("Gift Box option added", !!giftBox, JSON.stringify(p1?.options?.map((o: { name?: string }) => o.name)));
check("Gift Box has 3 variants", giftBox?.variants?.length === 3, String(giftBox?.variants?.length));
check("original description preserved", p1?.description?.includes("smoky Arabian oud"), String(p1?.description));
check("original option still present", !!p1?.options?.find((o: { name?: string }) => o.name === "Box"));
check("original variant description preserved", p1?.options?.find((o: { name?: string }) => o.name === "Box")?.variants?.[0]?.description === "Pocket-size roll-on");
check("assistantMessage present", typeof complex.assistantMessage === "string");
console.log("  assistantMessage:", (complex.assistantMessage || "").slice(0, 220));

console.log("=== Live: SIMPLE task (thinking OFF, compact context) ===");
const simple = await call("set all prices to 99");
check("simple parsed", Array.isArray(simple.products), JSON.stringify(simple.products).slice(0, 300));
const s1 = simple.products.find((p: Product) => p.id === "p1");
check("price applied to p1", s1?.sellingPrice === 99, String(s1?.sellingPrice));
check("description preserved under compact view", s1?.description?.includes("smoky Arabian oud"), String(s1?.description));
check("option preserved under compact view", !!s1?.options?.find((o: { name?: string }) => o.name === "Box"));
check("nested variant desc preserved", s1?.options?.find((o: { name?: string }) => o.name === "Box")?.variants?.[0]?.description === "Pocket-size roll-on");
check("inventory not touched", s1?.inventory === 5, String(s1?.inventory));

console.log(failures === 0 ? "\n=== Live intelligence E2E passed ===" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E crashed:", err.message);
  process.exit(1);
});
