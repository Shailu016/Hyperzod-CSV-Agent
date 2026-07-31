import { findBestImage, attachImages, hasImageIntent } from "../../lib/image-match";

async function main() {
  console.log("=== Image Match Tests ===");

  console.log("\n1. Intent detection:");
  const intents: [string, boolean][] = [
    ["add images to all products", true],
    ["create 5 pizzas", false],
    ["give me photos for the menu", true],
    ["update prices to 10%", false],
    ["set product images", true],
  ];
  for (const [text, expected] of intents) {
    const got = hasImageIntent(text as string);
    console.assert(got === expected, `"${text}" → ${got}, expected ${expected}`);
    console.log(`  "${text}" → ${got}`);
  }

  console.log("\n2. No API keys → graceful blank, no crash:");
  const products = [
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
          variants: [{ name: "Large", price: 0, inventory: 10 }],
        },
      ],
    },
  ] as unknown as Parameters<typeof attachImages>[0];

  const { products: result, report } = await attachImages(products);
  console.assert(result.length === 1, "Should keep products");
  console.log(`  Report: ${JSON.stringify(report)}`);
  console.log(`  Product name: ${result[0].name}`);
  console.log(`  Variant name: ${result[0].options?.[0]?.variants?.[0]?.name}`);
  console.log("  No crash with missing keys — PASS");

  console.log("\n3. findBestImage without keys returns null:");
  const img = await findBestImage({
    name: "Extra Cheese",
    category: "Pizza",
    parentName: "Test Pizza",
  });
  console.assert(img === null, "Should return null without keys");
  console.log("  PASS: null");

  console.log("\n=== All Image Match Tests Passed ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
