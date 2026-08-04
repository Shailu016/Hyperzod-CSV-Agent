import { mergeProducts } from "../../lib/patch-merge";

function mkProduct(over: Record<string, unknown> = {}) {
  return {
    id: over.id || "P1", name: over.name || "Oud Kuwaiti", sellingPrice: 289, costPrice: 230,
    category: "Attars- 6 ml", status: "active", inventory: 100, description: "<p>Long original product description that must never be lost.</p>",
    labels: ["Best Seller"], tags: ["oud"],
    options: [
      { name: "Pick Your Bottle", type: "single", enableRange: false, range: [0,1], required: true, view: "list",
        variants: [{ name: "Rose Gold", price: 0, costPrice: 0, inventory: 100, description: "A long original variant description with commas, and more text.", imageUrl: "https://a.b/c.jpg" }] },
    ],
    ...over,
  } as any;
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

console.log("=== BUG 1: product-level description truncation ===");
{
  const orig = [mkProduct()];
  const changes = [{ ...mkProduct(), description: "<p>SHORT</p>" }]; // model truncated
  const r = mergeProducts(orig, changes, false);
  check("product description preserved", r.products[0].description === orig[0].description,
    `got: ${r.products[0].description}`);
}

console.log("\n=== BUG 2: variant inventory edit silently ignored ===");
{
  const orig = [mkProduct()];
  const changes = [{ ...mkProduct(), options: [{ ...(orig[0].options || [])[0], variants: [{ name: "Rose Gold", price: 0, costPrice: 0, inventory: 5, description: (orig[0].options || [])[0].variants[0].description, imageUrl: (orig[0].options || [])[0].variants[0].imageUrl }] }] }];
  const r = mergeProducts(orig, changes, false);
  check("variant inventory edit applied (5)", (r.products[0].options || [])[0].variants[0].inventory === 5,
    `got: ${(r.products[0].options || [])[0].variants[0].inventory}`);
}

console.log("\n=== BUG 3: variant description NOT truncated (preserved) ===");
{
  const orig = [mkProduct()];
  const changes = [{ ...mkProduct(), options: [{ ...(orig[0].options || [])[0], variants: [{ name: "Rose Gold", price: 0, costPrice: 0, inventory: 100, description: "SHORT", imageUrl: (orig[0].options || [])[0].variants[0].imageUrl }] }] }];
  const r = mergeProducts(orig, changes, false);
  check("variant description preserved (long original wins)", (r.products[0].options || [])[0].variants[0].description === (orig[0].options || [])[0].variants[0].description,
    `got: ${(r.products[0].options || [])[0].variants[0].description}`);
}

console.log("\n=== BUG 4: rename creates duplicate ===");
{
  const orig = [mkProduct({ id: "P1", name: "Old Name" })];
  const changes = [{ ...mkProduct({ id: "P1", name: "Oud Kuwaiti" }) }]; // model renamed (kept id)
  const r = mergeProducts(orig, changes, false);
  check("rename matched by id → no duplicate", r.products.length === 1 && r.products[0].name === "Oud Kuwaiti",
    `products: ${r.products.length}, name: ${r.products[0]?.name}`);
}

console.log("\n=== BUG 4b: rename WITHOUT id (model drops id) ===");
{
  const orig = [mkProduct({ id: "P1", name: "Old Name" })];
  const changes = [{ ...mkProduct({ id: undefined, name: "Oud Kuwaiti" }) }];
  const r = mergeProducts(orig, changes, false);
  check("rename without id handled (no duplicate)", r.products.length === 1,
    `products: ${r.products.length}, names: ${r.products.map((p: any) => p.name).join(",")}`);
}

console.log("\n=== BUG 5: new option replicated to ALL products (over-application) ===");
{
  const orig = [mkProduct({ id: "P1", name: "Red Shirt" }), mkProduct({ id: "P2", name: "Blue Shirt" })];
  const changes = [{ ...mkProduct({ id: "P1", name: "Red Shirt" }), options: [
    ...(orig[0].options || []),
    { name: "Size", type: "single", enableRange: false, range: [0,1], required: true, view: "list", variants: [{ name: "M", price: 0, inventory: 10 }] },
  ] }]; // only P1 changed
  const r = mergeProducts(orig, changes, false);
  const p1Has = (r.products[0].options || []).some((o: any) => o.name === "Size");
  const p2Has = (r.products[1].options || []).some((o: any) => o.name === "Size");
  check("new option NOT forced onto untouched P2", !p2Has, `P2 has Size: ${p2Has}`);
  check("new option on P1", p1Has);
}

console.log("\n=== BUG 6: labels/tags empty from model wipe originals ===");
{
  const orig = [mkProduct()];
  const changes = [{ ...mkProduct(), labels: [], tags: [] }]; // model omitted
  const r = mergeProducts(orig, changes, false);
  check("labels preserved", (r.products[0].labels || []).length === 1, `got: ${JSON.stringify(r.products[0].labels)}`);
  check("tags preserved", (r.products[0].tags || []).length === 1, `got: ${JSON.stringify(r.products[0].tags)}`);
}

console.log(`\n=== RESULT: ${pass} pass, ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
