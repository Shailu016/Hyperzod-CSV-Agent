import { parseCSV } from "../../lib/parser";

const csv = [
  "PRODUCT.NAME,PRODUCT.PRICE.SELLING,PRODUCT.PRICE.COST,PRODUCT.CATEGORY,PRODUCT.STATUS,OPTION1.NAME,OPTION1.VARIANTS",
  "ZeroCost,100,0,Test,active,Size,\"S,50,0,10\"",
  "EmptyCost,100,,Test,active,,",
  "RealCost,100,60,Test,active,,",
  "HalfCost,0,0,Test,active,,",
].join("\n");

const products = parseCSV(csv);

for (const p of products) {
  const v = p.options?.[0]?.variants?.[0];
  console.log(
    `${p.name.padEnd(10)} cost=${p.costPrice} selling=${p.sellingPrice} variantCost=${v?.costPrice}`
  );
}

const zero = products.find((p) => p.name === "ZeroCost")!;
if (zero.costPrice !== 0 || zero.options![0].variants[0].costPrice !== 0) {
  console.error("FAIL: explicit 0 cost price was nullified");
  process.exit(1);
}
const empty = products.find((p) => p.name === "EmptyCost")!;
if (empty.costPrice != null) {
  console.error("FAIL: empty cost cell should stay undefined");
  process.exit(1);
}
const real = products.find((p) => p.name === "RealCost")!;
if (real.costPrice !== 60) {
  console.error("FAIL: normal cost price not preserved");
  process.exit(1);
}
const half = products.find((p) => p.name === "HalfCost")!;
if (half.costPrice !== 0 || half.sellingPrice !== 0) {
  console.error("FAIL: 0/0 prices corrupted");
  process.exit(1);
}
console.log("PASS: cost price 0 preserved, empty stays undefined");