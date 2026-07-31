import { normalizeProducts } from "../../lib/normalize";

const messy = [
  {
    name: "Test Pizza",
    sellingPrice: 499,
    category: "Pizza",
    options: [
      {
        name: "Size",
        type: "SINGLE",
        enableRange: "no",
        range: [0, 1],
        required: "YES",
        view: "LIST",
        variants: [{ name: "Small", price: 0, inventory: 5 }],
      },
      {
        name: "Toppings",
        type: "multiple",
        enableRange: "yes",
        range: [0, 3],
        required: "No",
        view: "Card",
        variants: [{ name: "Cheese", price: 50, inventory: 10 }],
      },
    ],
  },
];

const out = normalizeProducts(messy);
for (const o of out[0].options!) {
  console.log(
    o.name,
    "| type:",
    o.type,
    "| enableRange:",
    o.enableRange,
    "| required:",
    o.required,
    "| view:",
    o.view
  );
}
console.log("COERCION OK");
