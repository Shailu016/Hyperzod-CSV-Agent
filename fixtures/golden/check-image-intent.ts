import { hasImageIntent } from "../../lib/image-match";
import { authorizeEdit } from "../../lib/edit-intent";

const task = `In oud kuwaiti 6 ml category make the name as Oud Kuwaiti, add first option as Pick Your Bottle, make it required, and list rose gold elegance, golden elixir, rose royale, majestic filigree as variants. add second option as Pick Your Bottle, make it required and list rose gold elegance, ornate beauty, rose royale, majestic filigree as 12 ml bottles. add third add-on option name Pick Your Bottle and list rose royale, rose luminaire, imperial aureate, majestic filigree as 3 ml options. Lastly, add one more option as Choose This Signature Bottle For Free and list signature roll-on (Free)- 3ml, Signature roll-on (Free)- 6 ml, Signature roll-on (Free)- 12 ml add-ons are categories, and the variants are list`;

function isImageOnly(prompt: string): boolean {
  const imgAuth = authorizeEdit(prompt);
  return (
    hasImageIntent(prompt) &&
    imgAuth.fields.size === 1 &&
    imgAuth.fields.has("imageUrl") &&
    !imgAuth.touchesOptions
  );
}

console.log("1. User's Oud task → image intent?", hasImageIntent(task), "(expect false)");
console.assert(hasImageIntent(task) === false, "Oud task must NOT be image intent");
console.log("   → image-only shortcut?", isImageOnly(task), "(expect false)");

console.log("2. 'add images to all products' → image-only?", isImageOnly("add images to all products"), "(expect true)");
console.assert(isImageOnly("add images to all products") === true, "image request must be image-only");

console.log("3. 'set product pictures' → image-only?", isImageOnly("set product pictures"), "(expect true)");
console.assert(isImageOnly("set product pictures") === true, "pictures request must be image-only");

console.log("4. 'add images and set inventory to 10' → image-only?", isImageOnly("add images and set inventory to 10"), "(expect false — mixed intent goes to brain)");
console.assert(isImageOnly("add images and set inventory to 10") === false, "mixed intent must NOT shortcut");

console.log("5. 'Pick Your Bottle as option' alone → image?", hasImageIntent("Pick Your Bottle as option"), "(expect false)");
console.assert(hasImageIntent("Pick Your Bottle as option") === false, "Pick must not match");

console.log("\nALL PASS");
