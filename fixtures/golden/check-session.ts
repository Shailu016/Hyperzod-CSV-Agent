import { deriveSessionState, sessionBlock } from "../../lib/session";
import { judgeComplexity } from "../../lib/complexity";
import { stripForLLM } from "../../lib/strip";
import { mergeProducts } from "../../lib/patch-merge";
import type { Product, ChatMessage } from "../../lib/schema";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

function pass(name: string): void {
  console.log(`  ok: ${name}`);
}

const baseProducts: Product[] = [
  {
    id: "p1",
    name: "Oud Kuwaiti",
    description: "<p>A deep, smoky Arabian oud with rich resinous notes.</p>",
    sku: "SKU-1",
    sellingPrice: 45,
    costPrice: 20,
    inventory: 5,
    category: "Attars",
    status: "active",
    labels: ["Best Seller"],
    tags: ["oud", "unisex"],
    options: [
      {
        name: "Box",
        type: "single",
        enableRange: false,
        range: [0, 1],
        required: true,
        view: "list",
        variants: [
          {
            name: "6 ml",
            price: 0,
            costPrice: 10,
            inventory: 5,
            description: "Pocket-size roll-on bottle",
            nestedOptions: [
              {
                name: "Engraving",
                type: "single",
                enableRange: false,
                range: [0, 1],
                required: false,
                view: "list",
                variants: [
                  { name: "None", price: 0, inventory: 5 },
                  { name: "Gold", price: 10, inventory: 5 },
                ],
              },
            ],
          },
          { name: "12 ml", price: 4, costPrice: 15, inventory: 3 },
        ],
      },
    ],
  },
];

const simpleCatalog: Product[] = [
  { name: "A", sellingPrice: 100, category: "X", status: "active" },
  { name: "B", sellingPrice: 200, category: "X", status: "active" },
];

console.log("=== Session State ===");

const emptySession = deriveSessionState([], "set all prices to 499", simpleCatalog);
check("goal null when no history", emptySession.goal === null);
check("productCount", emptySession.productCount === 2, String(emptySession.productCount));
check("turnNumber = 1 for fresh", emptySession.turnNumber === 1, String(emptySession.turnNumber));
check("no continuation on fresh", emptySession.continuation === false);
pass("fresh session");

const history: ChatMessage[] = [
  { role: "user", content: "Add a Choose Your Box category to all products" },
  { role: "assistant", content: "Done — 43 products updated with 55 option groups. Review and export." },
  { role: "user", content: "also increase the box prices by 10%" },
];
const contSession = deriveSessionState(history, "also increase the box prices by 10%", simpleCatalog);
check("goal = first substantive task", !!contSession.goal?.includes("Choose Your Box"), String(contSession.goal));
check("lastAction captured", !!contSession.lastAction?.includes("43 products updated"), String(contSession.lastAction));
check("continuation detected (also)", contSession.continuation === true);
check("turnNumber = 3", contSession.turnNumber === 3, String(contSession.turnNumber));
pass("continuation session");

const qHistory: ChatMessage[] = [
  { role: "user", content: "create 5 pizzas" },
  { role: "assistant", content: "What price range would you like? 299-599?" },
];
const qSession = deriveSessionState(qHistory, "299 to 599", simpleCatalog);
check("pendingClarification = true", qSession.pendingClarification === true);
pass("clarification pending");

const deepSession = deriveSessionState([], "edit boxes", baseProducts);
check("catalogDepth = 2 (nested add-on)", deepSession.catalogDepth === 2, String(deepSession.catalogDepth));
check("totalVariants counts nested", deepSession.totalVariants === 4, String(deepSession.totalVariants));
check("productCount = 1", deepSession.productCount === 1);
pass("catalog depth");

const block = sessionBlock(contSession);
check("sessionBlock has task", block.includes("Task in progress"), block);
check("sessionBlock has products loaded", block.includes("Products loaded: 2"));
check("sessionBlock marks continuation", block.includes("CONTINUES"));
pass("sessionBlock");

console.log("=== Complexity Judge ===");
const emptyState = deriveSessionState([], "", []);

function judge(prompt: string, products: Product[] = simpleCatalog, intent: "csv_edit" | "csv_create" = "csv_edit") {
  const s = deriveSessionState([], prompt, products);
  return judgeComplexity(prompt, s, products, intent);
}

const simplePrice = judge("set all prices to 499");
check("simple price edit", simplePrice.tier === "simple", `${simplePrice.score}: ${simplePrice.reasons.join(";")}`);
check("...thinking off", simplePrice.thinking === false);
check("...compact context", simplePrice.context === "compact");
pass("set all prices to 499 → simple/compact");

const simpleStatus = judge("mark all products inactive");
check("simple status edit", simpleStatus.tier === "simple", `${simpleStatus.score}: ${simpleStatus.reasons.join(";")}`);
pass("mark all products inactive → simple");

const simpleInventory = judge("set inventory to 10");
check("simple inventory edit", simpleInventory.tier === "simple", String(simpleInventory.score));
pass("set inventory to 10 → simple");

const pctCheap = judge("make all products 15% cheaper");
check("percentage-only edit stays simple", pctCheap.tier === "simple", `${pctCheap.score}: ${pctCheap.reasons.join(";")}`);
pass("make all products 15% cheaper → simple (deterministic op)");

const createSmall = judge("create 3 t-shirts at 899 each", [], "csv_create");
check("small create simple", createSmall.tier === "simple", String(createSmall.score));
pass("create 3 t-shirts → simple");

const chooseBox = judge(
  "Add a Choose Your Box option to all products with 5 box variants at 45/49/75/95/0"
);
check("choose-your-box structural edit", chooseBox.tier === "complex", `${chooseBox.score}: ${chooseBox.reasons.join(";")}`);
check("...thinking on", chooseBox.thinking === true);
check("...full context", chooseBox.context === "full");
pass("add Choose Your Box to all → complex/thinking/full");

const conditional = judge("increase prices 10% except Oud Kuwaiti and rename its category to Premium Attars");
check("conditional + multi-field", conditional.tier === "complex", `${conditional.score}: ${conditional.reasons.join(";")}`);
pass("increase 10% except X → complex");

const remove = judge("remove the Large variant from every product");
check("destructive removal", remove.tier === "complex", `${remove.score}: ${remove.reasons.join(";")}`);
pass("remove variant from every → complex");

const createMany = judge("create 30 organic grocery items with add-ons", [], "csv_create");
check("large create", createMany.tier === "complex", `${createMany.score}: ${createMany.reasons.join(";")}`);
pass("create 30 with add-ons → complex");

const descEdit = judge("change the description of Oud Kuwaiti to premium quality");
check("description edit stays simple tier", descEdit.tier === "simple", String(descEdit.score));
check("...but gets full context", descEdit.context === "full");
pass("description edit → simple tier, full context");

const continuationPush = judge(
  "also set prices to 499",
  simpleCatalog
);
check("continuation alone doesn't force complex", continuationPush.tier === "simple", `${continuationPush.score}: ${continuationPush.reasons.join(";")}`);
pass("also + small edit stays simple");

console.log("=== Strip (adaptive context) ===");

const compact = stripForLLM(baseProducts, "compact");
const full = stripForLLM(baseProducts, "full");
check("compact has product name", compact[0].name === "Oud Kuwaiti");
check("compact has sellingPrice", compact[0].sellingPrice === 45);
check("compact omits product description", (compact[0] as Record<string, unknown>).description === undefined);
check("compact omits labels", (compact[0] as Record<string, unknown>).labels === undefined);
const compactOption = compact[0].options as Array<Record<string, unknown>>;
const compactVariant = compactOption[0].variants as Array<Record<string, unknown>>;
check("compact keeps variant prices", compactVariant[0].price === 0);
check("compact omits variant description", compactVariant[0].description === undefined);
check("compact omits nestedOptions", compactVariant[0].nestedOptions === undefined);
check("compact omits view", compactOption[0].view === undefined);
check("compact keeps option name", compactOption[0].name === "Box");
check("compact keeps type", compactOption[0].type === "single");
pass("compact view omits rich fields");

const fullOption = full[0].options as Array<Record<string, unknown>>;
const fullVariants = fullOption[0].variants as Array<Record<string, unknown>>;
check("full has product description", (full[0] as Record<string, unknown>).description !== undefined);
check("full keeps view", fullOption[0].view === "list");
check("full keeps variant description", fullVariants[0].description === "Pocket-size roll-on bottle");
check("full keeps nestedOptions", (fullVariants[0].nestedOptions as unknown[]).length === 1);
pass("full view carries rich fields");

console.log("=== Compact-mode merge safety ===");

// Simulate the real flow: compact strip → model changes PRICE only (echoes
// product with no description) → merge onto originals. Rich fields MUST survive.
const modelEcho = JSON.parse(JSON.stringify(compact)) as Array<Record<string, unknown>>;
(modelEcho[0] as Record<string, unknown>).sellingPrice = 99;
const mergeResult = mergeProducts(
  baseProducts,
  modelEcho as unknown as Product[],
  false,
  false
);
const merged = mergeResult.products[0];
check("merge preserves product description", merged.description === baseProducts[0].description, String(merged.description));
check("merge preserves labels", merged.labels?.[0] === "Best Seller");
check("merge preserves nested add-on", merged.options?.[0]?.variants?.[0]?.nestedOptions?.length === 1);
check("merge applies numeric change", merged.sellingPrice === 99, String(merged.sellingPrice));
check("merge keeps option view", merged.options?.[0]?.view === "list");
check("merge keeps variant description via longer-wins", merged.options?.[0]?.variants?.[0]?.description === "Pocket-size roll-on bottle");
pass("compact strip never loses data through the merge layer");

console.log(failures === 0 ? "\n=== All intelligence tests passed ===" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);