import { NextResponse } from "next/server";
import { ProductSchema } from "@/lib/schema";
import { generateCSV } from "@/lib/generator";
import { dedupeSkus } from "@/lib/dedupe-skus";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const products = Array.isArray(body) ? body : body.products;

    if (!Array.isArray(products)) {
      return NextResponse.json(
        { error: "Expected an array of products" },
        { status: 400 }
      );
    }

    const parsed = ProductSchema.array().safeParse(products);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid product data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const csv = generateCSV(dedupeSkus(parsed.data));

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="hyperzod_import_${Date.now()}.csv"`,
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
