import { NextResponse } from "next/server";
import { ProductSchema } from "@/lib/schema";
import { validateProducts } from "@/lib/validator";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!Array.isArray(body)) {
      const parsed = ProductSchema.array().safeParse(body.products);
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Invalid product list", details: parsed.error.flatten() },
          { status: 400 }
        );
      }
      const result = validateProducts(parsed.data);
      return NextResponse.json(result);
    }

    const parsed = ProductSchema.array().safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid product list", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = validateProducts(parsed.data);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
