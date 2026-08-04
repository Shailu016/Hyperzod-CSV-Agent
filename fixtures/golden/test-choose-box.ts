import { parseCSV } from "../../lib/parser";
import fs from "fs";

const BASE = "http://localhost:3000";

async function brain(prompt: string, currentProducts: unknown[], history: unknown[] = []) {
  const res = await fetch(`${BASE}/api/brain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, currentProducts, history }),
    signal: AbortSignal.timeout(300000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${data.error || "?"}`);
  return data;
}

async function main() {
  // Build a realistic catalog: 3 products, each with the 4 bottle options
  const makeProduct = (name: string) => ({
    name,
    sellingPrice: 289,
    costPrice: 230,
    status: "active",
    category: "Attars- 6 ml",
    options: [
      {
        name: "Pick Your Bottle",
        type: "single",
        enableRange: false,
        range: [0, 1],
        required: true,
        view: "list",
        variants: [
          { name: "Rose Gold Elegance", price: 0, inventory: 10 },
          { name: "Golden Elixir", price: 0, inventory: 10 },
          { name: "Rose Royale", price: 0, inventory: 10 },
          { name: "Majestic Filigree", price: 0, inventory: 10 },
        ],
      },
      {
        name: "Pick Your Bottle",
        type: "single",
        enableRange: false,
        range: [0, 1],
        required: true,
        view: "list",
        variants: [
          { name: "Rose Gold Elegance - 12 ml", price: 0, inventory: 10 },
          { name: "Ornate Beauty - 12 ml", price: 0, inventory: 10 },
          { name: "Rose Royale - 12 ml", price: 0, inventory: 10 },
          { name: "Majestic Filigree - 12 ml", price: 0, inventory: 10 },
        ],
      },
      {
        name: "Pick Your Bottle",
        type: "single",
        enableRange: false,
        range: [0, 1],
        required: false,
        view: "list",
        variants: [
          { name: "Rose Royale - 3 ml", price: 0, inventory: 10 },
          { name: "Rose Luminaire - 3 ml", price: 0, inventory: 10 },
          { name: "Imperial Aureate - 3 ml", price: 0, inventory: 10 },
          { name: "Majestic Filigree - 3 ml", price: 0, inventory: 10 },
        ],
      },
      {
        name: "Choose This Signature Bottle For Free",
        type: "single",
        enableRange: false,
        range: [0, 1],
        required: false,
        view: "list",
        variants: [
          { name: "Signature Roll-On (Free) - 3 ml", price: 0, inventory: 100 },
          { name: "Signature Roll-On (Free) - 6 ml", price: 0, inventory: 100 },
          { name: "Signature Roll-On (Free) - 12 ml", price: 0, inventory: 100 },
        ],
      },
    ],
  });

  const products = [makeProduct("Oud Kuwaiti"), makeProduct("Oud Elixir"), makeProduct("Oud Royale")];

  console.log(`Loaded ${products.length} products, each with 4 options`);

  // The exact failing task
  const task = `Add another category "Choose Your Box" and list the following five variants under it.
Signature Drawer Box (Rs.45)- A premium matte black luxury gift box with a soft satin interior- perfect for presenting attars, perfumes, and keepsakes with timeless elegance.
Imperial Arch Box (Rs.49)- A luxurious presentation box featuring rich black textures, radiant gold embossing, and the signature House of Muattar design. Crafted to elevate every fragrance into a memorable gift.
Royal heritage Box (Rs.75) for 6 ml & 3ml signature roll-on - A timeless blend of elegance and craftsmanship. Crafted from rich natural wood with refined brass detailing and a plush interior, it keeps your favorite attar bottle secure while making every gift feel truly luxurious.
Imperial Wood Case For 2 Attars (Rs.95) for 6 ml and 3 ml signature roll-on- Natural wood. Timeless craftsmanship. A gift box made to be treasured long after the fragrance is gone.
Velvet Pouch (Free)- An elegant pouch designed for your attar bottle. Perfect for keeping it safe and adding a special touch to your gift.`;

  console.log("\nSending task...");
  const r = await brain(task, products);
  console.log("Reply:", (r.assistantMessage || "").slice(0, 200));

  const oud = r.products.find((p: any) => p.name === "Oud Kuwaiti");
  const optCount = oud?.options?.length || 0;
  const box = oud?.options?.find((o: any) => o.name?.toLowerCase().includes("choose your box"));
  console.log(`\nOud Kuwaiti options: ${optCount} (expect 5)`);
  console.log(`Choose Your Box variants: ${box?.variants?.length ?? 0} (expect 5)`);
  console.log(`Variant names: ${box?.variants?.map((v: any) => v.name).join(" | ")}`);
  console.log(`Variant descriptions present: ${box?.variants?.filter((v: any) => v.description).length ?? 0}/5`);
  console.log(`Variant prices: ${box?.variants?.map((v: any) => v.price).join(", ")}`);

  const allProductsHaveBox = r.products.every((p: any) => (p.options || []).some((o: any) => o.name?.toLowerCase().includes("choose your box")));
  console.log(`All products got Choose Your Box: ${allProductsHaveBox}`);

  console.log("\n=== RESULT ===");
  console.log(`Options: ${optCount === 5 ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`Box variants: ${box?.variants?.length === 5 ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`Descriptions: ${(box?.variants?.filter((v: any) => v.description).length ?? 0) >= 3 ? "PASS ✅" : "partial"}`);
  console.log(`Prices: ${box?.variants?.some((v: any) => v.price > 0) ? "PASS ✅" : "FAIL ❌"}`);
}

main().catch((e) => {
  console.error("\nERROR:", e.message);
  process.exit(1);
});
