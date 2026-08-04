import { parseCSV } from "../../lib/parser";
import { generateCSV } from "../../lib/generator";
import fs from "fs";

const BASE = "http://localhost:3000";

async function brain(prompt: string, products: unknown[], history: unknown[] = []) {
  const res = await fetch(`${BASE}/api/brain`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, currentProducts: products, history }),
    signal: AbortSignal.timeout(300000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${data.error || "?"}`);
  return data;
}

async function main() {
  // Load the user's real CSV (with Choose Your Box already applied)
  const csv = fs.readFileSync("C:\\Users\\ahmad\\Downloads\\hyperzod_import_1785833991144.csv", "utf-8");
  const products = parseCSV(csv) as any[];
  console.log(`Loaded ${products.length} products`);

  // Baseline: count full descriptions / prices before edit
  const oud = products.find((p: any) => p.name === "Oud Kuwaiti");
  const boxBefore = oud?.options?.find((o: any) => o.name === "Choose Your Box");
  const descBefore = boxBefore?.variants?.map((v: any) => v.description?.length || 0);
  const priceBefore = boxBefore?.variants?.map((v: any) => v.price);
  console.log("BEFORE: Choose Your Box variants:", boxBefore?.variants?.length);
  console.log("  desc lengths:", descBefore);
  console.log("  prices:", priceBefore);

  // Run a NEW unrelated edit (e.g. set inventory) — must NOT degrade the boxes
  const r = await brain("set inventory to 5 for all products", products);
  const oud2 = r.products.find((p: any) => p.name === "Oud Kuwaiti");
  const boxAfter = oud2?.options?.find((o: any) => o.name === "Choose Your Box");
  const descAfter = boxAfter?.variants?.map((v: any) => v.description?.length || 0);
  const priceAfter = boxAfter?.variants?.map((v: any) => v.price);
  const invAfter = boxAfter?.variants?.map((v: any) => v.inventory);
  const prodInvAfter = oud2?.inventory;
  console.log("\nAFTER 'set inventory to 5':");
  console.log("  Choose Your Box still present:", !!boxAfter);
  console.log("  desc lengths:", descAfter, "(BEFORE:", descBefore, ")");
  console.log("  prices:", priceAfter, "(BEFORE:", priceBefore, ")");
  console.log("  variant inventory:", invAfter, "(should stay 100 — preserved)");
  console.log("  PRODUCT inventory:", prodInvAfter, "(expect 5)");

  const descsPreserved = JSON.stringify(descAfter) === JSON.stringify(descBefore);
  const pricesPreserved = JSON.stringify(priceAfter) === JSON.stringify(priceBefore);
  const prodInvApplied = prodInvAfter === 5;
  console.log(`\nResult: descs preserved ${descsPreserved ? "✅" : "❌"} | prices preserved ${pricesPreserved ? "✅" : "❌"} | PRODUCT inventory=5 ${prodInvApplied ? "✅" : "❌"}`);

  // Now the SAME Choose Your Box task on the already-having CSV (idempotency)
  const task = `Add another category "Choose Your Box" and list the following five variants under it. Signature Drawer Box (Rs.45)- desc1. Imperial Arch Box (Rs.49)- desc2. Velvet Pouch (Free)- desc3.`;
  const r2 = await brain(task, r.products);
  const oud3 = r2.products.find((p: any) => p.name === "Oud Kuwaiti");
  const boxAfter2 = oud3?.options?.find((o: any) => o.name === "Choose Your Box");
  console.log(`\nRe-run Choose Your Box task: option present ${!!boxAfter2}, variants: ${boxAfter2?.variants?.length}`);
  console.log("  desc lengths after re-run:", boxAfter2?.variants?.map((v: any) => v.description?.length || 0));
}

main().catch(e => console.error(e.message));
