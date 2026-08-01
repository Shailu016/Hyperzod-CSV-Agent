import { authorizeEdit, extractNumericOps, applyNumericOp } from "../../lib/edit-intent";
import { deepDiffProducts, restoreEntries } from "../../lib/deep-diff";
import type { Product } from "../../lib/schema";

// Product with rich data that must NEVER change on an unrelated edit
function richProduct(): Product {
  return {
    name: "Corn Pizza",
    description: "<p>Delicious corn pizza with cheese.</p>",
    sku: "PIZ-001",
    sellingPrice: 499,
    costPrice: 200,
    priceCompare: 599,
    minQty: 1,
    maxQty: 5,
    taxPercent: 5,
    status: "active",
    inventory: 100,
    labels: ["Best Seller"],
    category: "Pizza",
    tags: ["corn", "veg"],
    imageUrl: "",
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
            inventory: 50,
            description: "12 inch",
            imageUrl: "",
            nestedOptions: [
              {
                name: "Crust",
                type: "single",
                enableRange: false,
                range: [0, 1],
                required: true,
                view: "list",
                variants: [{ name: "Thin", price: 0, inventory: 50, imageUrl: "" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function main() {
  console.log("=== Edit Safety Test ===");

  // ── 1. Authorizer ──
  console.log("\n1. Authorizer:");
  const a1 = authorizeEdit("set inventory to 10 for all products");
  console.log("  'set inventory to 10' →", [...a1.fields], a1.hasFieldTarget);
  console.assert(a1.fields.has("inventory") && !a1.fields.has("description"), "only inventory authorized");

  const a2 = authorizeEdit("increase all prices by 10%");
  console.log("  'increase prices 10%' →", [...a2.fields]);
  console.assert(a2.fields.has("sellingPrice"), "sellingPrice authorized");

  const a3 = authorizeEdit("hello there");
  console.log("  'hello there' → hasFieldTarget:", a3.hasFieldTarget);
  console.assert(!a3.hasFieldTarget, "no target → clarify");

  // ── 2. Numeric ops are exact ──
  console.log("\n2. Numeric ops (computed in code):");
  const ops = extractNumericOps("increase all prices by 10%");
  const p1 = applyNumericOp(richProduct(), ops[0]);
  console.log(`  499 → ${p1.sellingPrice} (expect 548.9)`);
  console.assert(p1.sellingPrice === 548.9, "exact 10% math");

  // ── 3. Diff detects tampering ──
  console.log("\n3. Deep diff detects unauthorized change:");
  const before = [richProduct()];
  const tampered = JSON.parse(JSON.stringify(before)) as Product[];
  tampered[0].inventory = 10;                    // authorized
  tampered[0].description = "<p>HACKED</p>";     // unauthorized
  tampered[0].labels = ["Evil"];                 // unauthorized
  tampered[0].options![0].variants[0].nestedOptions![0].variants[0].price = 99; // unauthorized

  const diffs = deepDiffProducts(before, tampered);
  console.log("  diff paths:", diffs.map((d) => d.path).join(" | "));
  console.assert(diffs.some((d) => d.path === "inventory"), "inventory diff detected");
  console.assert(diffs.some((d) => d.path === "description"), "description diff detected");

  // ── 4. Restore unauthorized only ──
  console.log("\n4. Restore unauthorized (keep authorized):");
  const auth = authorizeEdit("set inventory to 10 for all products");
  const unauthorized = diffs.filter((d) => !auth.fields.has(d.rootField));
  const nestedDiff = diffs.find((d) => d.path.includes("Crust"));
  console.log("  nested diff path:", nestedDiff?.path);
  console.log("  nested diff before:", nestedDiff?.before, "after:", nestedDiff?.after);
  const nm = nestedDiff?.path.match(/^options\/(.+?)\/nested \(variant "(.+?)"\)\/(.+?)\/(.+?) \(variant "(.+?)"\)$/);
  console.log("  regex match:", nm ? JSON.stringify(nm.slice(1)) : "NO MATCH");
  const restored = restoreEntries(tampered, unauthorized);
  console.log("  description restored:", restored[0].description === "<p>Delicious corn pizza with cheese.</p>" ? "YES ✓" : "NO ✗");
  console.log("  labels restored:", restored[0].labels?.join() === "Best Seller" ? "YES ✓" : "NO ✗");
  console.log("  nested price restored:", restored[0].options![0].variants[0].nestedOptions![0].variants[0].price === 0 ? "YES ✓" : "NO ✗");
  console.log("  inventory KEPT at 10:", restored[0].inventory === 10 ? "YES ✓" : "NO ✗");
  console.assert(restored[0].description === "<p>Delicious corn pizza with cheese.</p>", "desc restored");
  console.assert(restored[0].inventory === 10, "authorized change kept");

  console.log("\n=== ALL PASS ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
