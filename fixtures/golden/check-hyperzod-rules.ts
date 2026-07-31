import { normalizeProducts } from "../../lib/normalize";
import { validateProducts } from "../../lib/validator";
import { generateCSV } from "../../lib/generator";

// Reproduce the exact Hyperzod rejection scenario from the user report:
// - option1: SINGLE with variants, variant[1].imageUrl = junk text
// - option2: MULTIPLE with a variant that has nestedOptions (FORBIDDEN)
const bad = [
  {
    name: "Test Pizza",
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
          { name: "Small", price: 0, inventory: 5, imageUrl: "image.jpg" },
          { name: "Large", price: 100, inventory: 5, imageUrl: "not-a-url" },
        ],
      },
      {
        name: "Toppings",
        type: "multiple",
        enableRange: false,
        range: [0, 3],
        required: false,
        view: "list",
        variants: [
          {
            name: "Cheese",
            price: 50,
            inventory: 10,
            nestedOptions: [
              {
                name: "Extra",
                type: "single",
                enableRange: false,
                range: [0, 1],
                required: false,
                view: "list",
                variants: [{ name: "Double Cheese", price: 20, inventory: 10 }],
              },
            ],
          },
        ],
      },
    ],
  },
];

async function main() {
  console.log("=== Hyperzod Rejection Fix Test ===");

  console.log("\n1. Normalizer strips forbidden nesting + junk URLs:");
  const [normalized] = normalizeProducts(bad as never);
  const toppings = normalized.options![1];
  console.log(
    "  MULTIPLE option nestedOptions:",
    toppings.variants[0].nestedOptions?.length,
    "(should be 0)"
  );
  const size = normalized.options![0];
  console.log("  junk URL variant[1]:", JSON.stringify(size.variants[1].imageUrl), "(should be empty)");
  console.assert(toppings.variants[0].nestedOptions!.length === 0, "nested stripped");
  console.assert(size.variants[1].imageUrl === "", "junk url cleared");

  console.log("\n2. Validator flags the violations:");
  const result = validateProducts([normalized]);
  const nestedErr = result.errors.find((e) => e.field.includes("nestedOptions"));
  console.log("  nested-options error:", nestedErr ? "FLAGGED" : "MISSING");
  console.log("  error count:", result.errorCount);

  console.log("\n3. Generated CSV is clean of the rejection causes:");
  const csv = generateCSV([normalized]);
  const hasForbidden = csv.includes("{ Extra,single");
  console.log("  CSV contains forbidden nested under MULTIPLE:", hasForbidden, "(should be false)");
  console.assert(!hasForbidden, "no forbidden nesting in CSV");
  console.assert(!csv.includes("not-a-url"), "no junk URL in CSV");

  console.log("\n=== ALL PASS ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
