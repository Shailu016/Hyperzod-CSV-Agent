import { NextResponse } from "next/server";
import { ProductSchema } from "@/lib/schema";
import { attachImages } from "@/lib/image-match";

export const maxDuration = 300;

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

    const { products: withImages, report } = await attachImages(parsed.data);

    return NextResponse.json({ products: withImages, report });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
