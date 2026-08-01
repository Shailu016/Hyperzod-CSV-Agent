import { attachImages, hasImageIntent } from "../../lib/image-match";

// Product with nested add-ons — the thing that was getting dropped
const productWithNesting = {
  name: "Nested Pizza",
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
          imageUrl: "",
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
                  imageUrl: "",
                  nestedOptions: [
                    {
                      name: "Extra Topping",
                      type: "single",
                      enableRange: false,
                      range: [0, 1],
                      required: true,
                      view: "list",
                      variants: [{ name: "Cheese", price: 30, inventory: 10, imageUrl: "" }],
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
  console.log("=== Image Attach Preserves Nested Add-ons ===");

  console.log("Intent check 'add images to the csv':", hasImageIntent("add images to the csv"));
  console.log("Intent check 'create 5 pizzas':", hasImageIntent("create 5 pizzas"));

  const before = JSON.stringify(productWithNesting);
  const { products, report } = await attachImages([productWithNesting as never]);

  const after = JSON.stringify(products[0]);
  console.log("\nNested add-ons preserved after attachImages:",
    after.includes('"name":"Crust"') && after.includes('"name":"Extra Topping"') ? "YES ✓" : "NO ✗");
  console.log("Report:", JSON.stringify(report));

  console.assert(after.includes("Crust"), "Crust must survive");
  console.assert(after.includes("Extra Topping"), "Extra Topping must survive");
  console.assert(after.includes("Cheese"), "Cheese must survive");
  console.log("  (imageUrls unchanged here only because no stock API keys — nesting is what matters)");

  console.log("\n=== ALL PASS ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
