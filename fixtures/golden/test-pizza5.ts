export {};

const BASE = "http://localhost:3000";

async function call(prompt: string) {
  const res = await fetch(`${BASE}/api/brain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, currentProducts: [], history: [] }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  const prompt =
    "Create 5 pizza products with size options (Small/Medium/Large) and topping add-ons, ₹299-₹599 each";
  console.log("Prompt:", prompt);
  const { status, data } = await call(prompt);
  console.log("HTTP:", status);
  if (data.error || !Array.isArray(data.products)) {
    console.log("ERROR:", data.error, "|", data.message || "");
    process.exit(1);
  }
  console.log("products:", data.products.length);
  const p0 = data.products[0];
  console.log("first:", p0?.name, "| price:", p0?.sellingPrice, "| options:", p0?.options?.length);
  for (const p of data.products) {
    const opts = (p.options || []).map((o: { name: string }) => o.name);
    console.log(" -", p.name, "| ₹" + p.sellingPrice, "|", opts.join(", "));
  }
  console.log("PASS");
}

main().catch((e) => {
  console.error("crashed:", e.message);
  process.exit(1);
});
