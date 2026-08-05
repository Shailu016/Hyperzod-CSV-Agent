export {};

const BASE = "http://localhost:3000";

async function callAPI(prompt: string) {
  const res = await fetch(`${BASE}/api/brain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, currentProducts: [], history: [] }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, data.error || data.message);
    process.exit(1);
  }
  return data;
}

async function main() {
  console.log("=== Normal path (fits budget) ===");
  const r = await callAPI("Create 3 pizzas with size and toppings at 299 each");
  console.log("products:", r.products.length);
  console.log("msg:", r.assistantMessage.substring(0, 150));
  if (r.products.length === 0) {
    console.error("FAIL: expected 3 products");
    process.exit(1);
  }
  console.log("PASS\n");

  console.log("=== Batch mode (> budget) ===");
  const r2 = await callAPI("Create 15 products with add-ons across categories like Electronics, Fashion, Food");
  console.log("products:", r2.products.length);
  console.log("msg:", r2.assistantMessage.substring(0, 200));
  if (r2.products.length < 5) {
    console.error("FAIL: expected >= 5 products from batch mode");
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((err) => {
  console.error("Test crashed:", err.message);
  process.exit(1);
});
