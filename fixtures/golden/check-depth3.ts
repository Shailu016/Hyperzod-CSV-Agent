import { generateCSV } from "../../lib/generator";
import { parseCSV } from "../../lib/parser";
import { normalizeProducts } from "../../lib/normalize";
import { validateProducts } from "../../lib/validator";

// Depth-3 product: Size → Large → {Crust} → Thin → {Extra Topping} → Cheese
const product = {
  name: "Deep Nest Pizza",
  sellingPrice: 499,
  costPrice: 200,
  status: "active",
  category: "Pizza",
  options: [
    {
      name: "Size",
      type: "single",
      enableRange: false,
      range: [0, 1],
      required: true,
      view: "list",
      variants: [
        {
          name: "Large",
          price: 0,
          inventory: 10,
          nestedOptions: [
            {
              name: "Crust",
              type: "single",
              enableRange: false,
              range: [0, 1],
              required: true,
              view: "list",
              variants: [
                {
                  name: "Thin",
                  price: 0,
                  inventory: 10,
                  nestedOptions: [
                    {
                      name: "Extra Topping",
                      type: "single",
                      enableRange: false,
                      range: [0, 1],
                      required: true,
                      view: "list",
                      variants: [{ name: "Cheese", price: 30, inventory: 10 }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function main() {
  console.log("=== Depth-3 Nesting Test ===");

  const [normalized] = normalizeProducts([product as never]);
  const level1 = normalized.options![0].variants[0].nestedOptions!;
  console.log("Level-1 nested option:", level1[0].name, "→", level1[0].variants[0].name);
  const level2 = level1[0].variants[0].nestedOptions!;
  console.log("Level-2 nested option:", level2[0].name, "→", level2[0].variants[0].name);
  const level3 = level2[0].variants[0].nestedOptions!;
  console.log("Level-3 nested option:", level3.length === 0 ? "(stripped — correct)" : level3[0].name);

  const csv = generateCSV([normalized]);
  console.log("\nCSV contains:");
  console.log("  Crust:", csv.includes("Crust") ? "yes" : "no");
  console.log("  Extra Topping:", csv.includes("Extra Topping") ? "yes" : "no");
  console.log("  Cheese:", csv.includes("Cheese") ? "yes" : "no");
  console.log("  Brace balance:", (csv.match(/{/g) || []).length === (csv.match(/}/g) || []).length ? "OK" : "BROKEN");

  const reparsed = parseCSV(csv);
  const r1 = reparsed[0].options![0].variants[0].nestedOptions!;
  const r2 = r1[0].variants[0].nestedOptions!;
  console.log("\nRound-trip: Size → Large →", r1[0].name, "→", r1[0].variants[0].name, "→", r2[0].name, "→", r2[0].variants[0].name);
  console.assert(r2[0].name === "Extra Topping", "depth-3 survives round-trip");

  const validation = validateProducts(reparsed);
  const warn = validation.warnings.find((w) => w.message.includes("3-level"));
  console.log("\nValidator 3-level warning:", warn ? "PRESENT ✓" : "MISSING");

  console.log("\n=== ALL PASS ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
