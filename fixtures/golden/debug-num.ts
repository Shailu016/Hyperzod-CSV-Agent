import { mergeProducts } from "../../lib/patch-merge";
import { applyNumericOp, extractNumericOps } from "../../lib/edit-intent";

const orig = [{
  name: "X", sellingPrice: 100, category: "C", status: "active", inventory: 100,
  options: [{ name: "Opt", type: "single", enableRange: false, range: [0,1], required: true, view: "list",
    variants: [{ name: "V1", price: 0, inventory: 100, description: "long desc here" }] }],
} as any];

// model echoes product with inventory 100 (didn't change it), full option
const changes = [{
  name: "X", sellingPrice: 100, category: "C", status: "active", inventory: 100,
  options: [{ name: "Opt", type: "single", enableRange: false, range: [0,1], required: true, view: "list",
    variants: [{ name: "V1", price: 0, inventory: 100, description: "long desc here" }] }],
} as any];

const merged = mergeProducts(orig, changes, false);
const ops = extractNumericOps("set inventory to 5 for all products");
console.log("ops:", JSON.stringify(ops));
const final = merged.products.map((p: any) => ops.reduce((acc, op) => applyNumericOp(acc, op), p));
console.log("inventory after numeric op:", final[0].inventory, "(expect 5)");
