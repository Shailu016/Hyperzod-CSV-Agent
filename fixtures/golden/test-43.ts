export {};

const BASE = "http://localhost:3000";

async function brain(prompt: string, products: unknown[]) {
  const res = await fetch(`${BASE}/api/brain`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, currentProducts: products, history: [] }),
    signal: AbortSignal.timeout(300000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${data.error || "?"}`);
  return data;
}

async function main() {
  // Simulate 43 products with options — use 43 products, each with 1 option for speed
  const products = Array.from({length: 43}, (_, i) => ({
    name: `Oud Test ${i+1}`,
    sellingPrice: 289, costPrice: 230, status: "active", category: "Attars- 6 ml",
    options: [
      { name: "Pick Your Bottle", type: "single", enableRange: false, range: [0,1], required: true, view: "list",
        variants: [{ name: "Rose Gold Elegance", price: 0, inventory: 10 }, { name: "Golden Elixir", price: 0, inventory: 10 }] }
    ],
  }));
  const beforeOpts = products.reduce((s: number, p: any) => s + (p.options || []).length, 0);
  console.log(`BEFORE: ${products.length} products, ${beforeOpts} options`);

  const task = `Add category "Choose Your Box" with variants: Signature Drawer Box (Rs.45), Imperial Arch Box (Rs.49), Velvet Pouch (Free)`;
  const r = await brain(task, products);

  const afterOpts = r.products.reduce((s: number, p: any) => s + (p.options || []).length, 0);
  const withBox = r.products.filter((p: any) => (p.options||[]).some((o: any) => o.name === "Choose Your Box")).length;
  console.log(`AFTER: ${afterOpts} options, ${withBox}/${r.products.length} have Choose Your Box`);
  console.log(`Expected: ${beforeOpts + r.products.length} options (all products get +1)`);

  const preserved = afterOpts >= beforeOpts;
  const allGotBox = withBox === r.products.length;
  console.log(`Preserved: ${preserved ? "✅" : "❌"}, All got box: ${allGotBox ? "✅" : "❌"}`);
}

main().catch(e => console.error(e.message));
