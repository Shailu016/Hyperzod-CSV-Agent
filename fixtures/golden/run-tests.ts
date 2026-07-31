import { generateCSV } from "../../lib/generator";
import { validateProducts } from "../../lib/validator";
import type { Product } from "../../lib/schema";

// Golden fixture: Simple product with no options
const fixture1: Product[] = [
  {
    name: "Test T-Shirt",
    description: "<p>Basic cotton t-shirt</p>",
    sku: "TSH-001",
    sellingPrice: 899,
    costPrice: 350,
    status: "active",
    inventory: 100,
    labels: ["Best Seller"],
    category: "T-Shirts",
    tags: ["cotton", "basic"],
    _fieldConfidence: { name: "stated", sellingPrice: "stated" },
  },
];

// Golden fixture: Product with single-select option (size variants)
const fixture2: Product[] = [
  {
    name: "Pizza Margherita",
    sku: "PIZ-001",
    sellingPrice: 299,
    costPrice: 120,
    status: "active",
    category: "Pizza",
    options: [
      {
        name: "Pizza Size",
        type: "single",
        enableRange: false,
        range: [0, 1],
        required: true,
        view: "list",
        variants: [
          { name: "Small", price: 0, minQty: 0, description: "10 inch" },
          { name: "Medium", price: 100, minQty: 0, description: "12 inch" },
          { name: "Large", price: 200, minQty: 0, description: "14 inch" },
        ],
      },
    ],
    _fieldConfidence: {},
  },
];

// Golden fixture: Product with nested add-ons (variant → nested option)
const fixture3: Product[] = [
  {
    name: "Custom Laptop",
    sku: "LAP-001",
    sellingPrice: 59999,
    costPrice: 42000,
    status: "active",
    category: "Electronics",
    options: [
      {
        name: "Processor",
        type: "single",
        enableRange: false,
        range: [0, 1],
        required: true,
        view: "list",
        variants: [
          {
            name: "Core i5",
            price: 0,
            minQty: 0,
            description: "10th Gen i5",
            nestedOptions: [
              {
                name: "RAM Upgrade",
                type: "single",
                enableRange: false,
                range: [0, 1],
                required: false,
                view: "list",
                variants: [
                  { name: "8GB DDR4", price: 0, minQty: 0 },
                  { name: "16GB DDR4", price: 2500, minQty: 0 },
                ],
              },
            ],
          },
          {
            name: "Core i7",
            price: 8000,
            minQty: 0,
            description: "12th Gen i7",
            nestedOptions: [
              {
                name: "RAM Upgrade",
                type: "single",
                enableRange: false,
                range: [0, 1],
                required: false,
                view: "list",
                variants: [
                  { name: "16GB DDR4", price: 0, minQty: 0 },
                  { name: "32GB DDR4", price: 5000, minQty: 0 },
                ],
              },
            ],
          },
        ],
      },
    ],
    _fieldConfidence: {},
  },
];

// Bad fixture: missing required fields
const badFixture1: Product[] = [
  {
    name: "",
    sellingPrice: 0,
    status: "active",
    category: "",
    _fieldConfidence: {},
  } as Product,
];

// Bad fixture: priceCompare < sellingPrice
const badFixture2: Product[] = [
  {
    name: "Test",
    sellingPrice: 1000,
    priceCompare: 500,
    status: "active",
    category: "Test",
    _fieldConfidence: {},
  },
];

console.log("=== Generator Tests ===");

console.log("\n1. Simple product (no options):");
const csv1 = generateCSV(fixture1);
console.log(csv1.slice(0, 500));
console.assert(
  csv1.includes("Test T-Shirt"),
  "Should contain product name"
);
console.assert(
  csv1.includes("OPTION1.NAME"),
  "Should have at least one option column"
);
console.log("PASS: Simple product");

console.log("\n2. Product with size variants:");
const csv2 = generateCSV(fixture2);
console.log(csv2.slice(0, 800));
console.assert(csv2.includes("Pizza Size"), "Should contain option name");
console.assert(
  csv2.includes("Small,0,0,0,10 inch,"),
  "Should contain variant string"
);
console.assert(csv2.includes(" ; "), "Should use semicolon separator");
console.log("PASS: Size variants");

console.log("\n3. Product with nested add-ons:");
const csv3 = generateCSV(fixture3);
console.log(csv3.slice(0, 1200));
console.assert(
  csv3.includes("{ RAM Upgrade,single,no"),
  "Should contain nested option"
);
console.assert(
  csv3.includes('"[0,1]"'),
  "Nested range should be bracketed and quoted"
);
console.log("PASS: Nested add-ons");

console.log("\n=== Validator Tests ===");

console.log("\n4. Validate valid product:");
const r1 = validateProducts(fixture1);
console.assert(r1.valid === true, "Should be valid");
console.log(`PASS: Valid (${r1.errorCount} errors, ${r1.warningCount} warnings)`);

console.log("\n5. Validate missing required fields:");
const r2 = validateProducts(badFixture1);
console.assert(r2.errorCount > 0, "Should have errors");
console.log(`PASS: Caught ${r2.errorCount} errors`);
r2.errors.forEach((e) => console.log(`  - ${e.field}: ${e.message}`));

console.log("\n6. Validate priceCompare < sellingPrice:");
const r3 = validateProducts(badFixture2);
console.assert(
  r3.errors.some((e) => e.field === "priceCompare"),
  "Should catch price compare issue"
);
console.log(`PASS: Caught price compare error`);

console.log("\n=== All Tests Passed ===");
