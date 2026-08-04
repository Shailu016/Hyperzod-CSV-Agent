import { deterministicIntent, isTrivialMessage } from "../../lib/router";

const cases: [string, boolean, string][] = [
  ["fix this", true, "csv_edit"],
  ["fix the broken images", true, "csv_edit"],
  ["remove all products", true, "csv_edit"],
  ["what about raising prices?", true, "csv_edit"],
  ["change inventory to 50", true, "csv_edit"],
  ["what can you do?", true, "chat"],
  ["how does this tool work?", true, "chat"],
  ["hello", true, "chat"],
  ["thanks", true, "chat"],
  ["create 10 pizzas", false, "csv_create"],
  ["give me 100 car products", false, "csv_create"],
  // Question phrases that must NOT become edits
  ["tell me the data of csv which i have uploaded", true, "chat"],
  ["show me the products you added", true, "chat"],
  ["what is the price of the first product", true, "chat"],
  ["list the categories in the csv", true, "chat"],
  ["describe what changed", true, "chat"],
  ["how many products are loaded", true, "chat"],
  ["update the price of the red shirt", true, "csv_edit"],
];

let pass = true;
for (const [msg, has, expected] of cases) {
  const got = deterministicIntent(msg, has);
  const ok = got === expected;
  if (!ok) pass = false;
  console.log(`${ok ? "PASS" : "FAIL"}: "${msg}" (has=${has}) → ${got}, expected ${expected}`);
}
console.log(`PASS: "ok" trivial-guard → ${isTrivialMessage("ok") ? "caught (chat)" : "NOT caught"}`);
console.assert(isTrivialMessage("ok"), "trivial guard should catch ok");
console.log(pass ? "ALL PASS" : "SOME FAILED");
