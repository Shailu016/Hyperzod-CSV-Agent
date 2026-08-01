import { authorizeEdit } from "../../lib/edit-intent";

const cases: [string, boolean, string[]][] = [
  ["update addons again", true, []],
  ["update add-ons again", true, []],
  ["change the options", true, []],
  ["add new variants", true, []],
  ["update toppings", true, []],
  ["remove the blue color", true, []],
  ["set inventory to 10", true, ["inventory"]],
  ["update skus", true, ["sku"]],
  ["hello there", false, []],
  ["what can you do", false, []],
  // Typo tolerance
  ["updte addons", true, []],
  ["incrse price of all", true, ["sellingPrice"]],
  ["stok set karo", true, ["inventory"]],
  ["chage category", true, ["category"]],
  // Hinglish / other languages
  ["price badhao", true, ["sellingPrice"]],
  ["daam kam karo", true, ["sellingPrice"]],
  ["photos change karo", true, ["imageUrl"]],
  ["adons update", true, []],
  ["stetus active karo", true, ["status"]],
];

let pass = true;
for (const [msg, expectTarget, expectFields] of cases) {
  const auth = authorizeEdit(msg);
  const ok = auth.hasFieldTarget === expectTarget;
  const fieldsOk = expectFields.every((f) => auth.fields.has(f));
  if (!ok || !fieldsOk) pass = false;
  console.log(
    `${ok && fieldsOk ? "PASS" : "FAIL"}: "${msg}" → target=${auth.hasFieldTarget} fields=[${[...auth.fields].join(",")}]`
  );
}
console.log(pass ? "ALL PASS" : "SOME FAILED");
