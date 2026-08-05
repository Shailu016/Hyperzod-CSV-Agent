import { dedupeSkus } from "../../lib/dedupe-skus";

const dupSkuList =
  "ELEC009, FASH003, FASH007, FASH008, HOME008, SPRT010, BEAU008, BEAU010, TOYS001, TOYS003, TOYS005, TOYS007, TOYS008, TOYS009, TOYS010, FASH010, HOME002, HOME003, HOME006, HOME007, HOME010, SPRT002, SPRT006, SPRT008, SPRT009, BEAU004, BEAU005, BEAU007, BEAU009, TOYS004, TOYS006, HOME004".split(
    ", "
  );

const products: Array<{
  name: string;
  sku: string;
  sellingPrice: number;
  costPrice: number;
  category: string;
  status: "active" | "inactive";
}> = [];
for (let i = 0; i < 3; i++) {
  dupSkuList.forEach((sku) => {
    products.push({
      name: `Prod ${sku} rep${i}`,
      sku,
      sellingPrice: 100,
      costPrice: 60,
      category: "Test",
      status: "active",
    });
  });
}

const deduped = dedupeSkus(products);
const seen = new Set<string>();
const dupes: string[] = [];
for (const p of deduped) {
  if (seen.has(p.sku!.toLowerCase())) dupes.push(p.sku!);
  seen.add(p.sku!.toLowerCase());
}

console.log("input:", products.length, "output:", deduped.length);
console.log("remaining duplicates:", dupes.length ? dupes : "NONE");
console.log("samples:", deduped.map((p) => p.sku).slice(0, 12));

if (dupes.length > 0) {
  console.error("FAIL: duplicate SKUs remain");
  process.exit(1);
}

const originalsKept = products.filter((p) =>
  deduped.some((d) => d.sku === p.sku)
).length;
const maxLen = Math.max(...deduped.map((p) => p.sku!.length));
console.log("first occurrences kept:", originalsKept, "max sku length:", maxLen);
console.log("PASS: all SKUs unique");