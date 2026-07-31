import { z } from "zod";

export interface ProductVariant {
  name: string;
  price: number;
  costPrice?: number;
  minQty: number;
  maxQty?: number;
  description?: string;
  imageUrl?: string;
  nestedOptions?: ProductOption[];
}

export interface ProductOption {
  name: string;
  type: "single" | "multiple";
  enableRange: boolean;
  range: [number, number];
  required: boolean;
  view: "list" | "card";
  variants: ProductVariant[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ProductVariantSchema: z.ZodType<any> = z.object({
  name: z.string().min(1),
  price: z.number().default(0),
  costPrice: z.number().optional(),
  minQty: z.number().default(0),
  maxQty: z.number().optional(),
  description: z.string().optional().default(""),
  imageUrl: z.string().optional().default(""),
  nestedOptions: z.array(z.lazy(() => ProductOptionSchema)).optional().default([]),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ProductOptionSchema: z.ZodType<any> = z.object({
  name: z.string().min(1),
  type: z.enum(["single", "multiple"]),
  enableRange: z.boolean().default(false),
  range: z.tuple([z.number(), z.number()]).default([0, 0]),
  required: z.boolean().default(false),
  view: z.enum(["list", "card"]),
  variants: z.array(ProductVariantSchema).default([]),
});

export const ProductSchema = z.object({
  name: z.string().min(1, "Product name is required"),
  description: z.string().optional().default(""),
  sku: z.string().optional().default(""),
  sellingPrice: z.number({ required_error: "Selling price is required" }),
  costPrice: z.number().optional(),
  priceCompare: z.number().optional(),
  minQty: z.number().optional(),
  maxQty: z.number().optional(),
  taxPercent: z.number().optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  inventory: z.number().optional(),
  labels: z.array(z.string()).optional().default([]),
  category: z.string().min(1, "Category is required"),
  tags: z.array(z.string()).optional().default([]),
  imageUrl: z.string().optional().default(""),
  options: z.array(ProductOptionSchema).optional().default([]),
  _fieldConfidence: z.record(z.string(), z.enum(["stated", "inferred"])).optional().default({}),
});

export interface Product {
  name: string;
  description?: string;
  sku?: string;
  sellingPrice: number;
  costPrice?: number;
  priceCompare?: number;
  minQty?: number;
  maxQty?: number;
  taxPercent?: number;
  status: "active" | "inactive";
  inventory?: number;
  labels?: string[];
  category: string;
  tags?: string[];
  imageUrl?: string;
  options?: ProductOption[];
  _fieldConfidence?: Record<string, "stated" | "inferred">;
}

export const BrainRequestSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  currentProducts: z.array(ProductSchema).optional().default([]),
});

export type BrainRequest = z.infer<typeof BrainRequestSchema>;

export const BrainResponseSchema = z.object({
  products: z.array(ProductSchema),
  assistantMessage: z.string(),
  clarifyingQuestion: z.string().optional(),
});

export type BrainResponse = z.infer<typeof BrainResponseSchema>;

export const CSVMeta = {
  HEADERS: [
    "PRODUCT.ID",
    "PRODUCT.NAME",
    "PRODUCT.DESCRIPTION",
    "PRODUCT.SKU",
    "PRODUCT.PRICE.COMPARE",
    "PRODUCT.MIN.MAX.QUANTITY",
    "PRODUCT.PRICE.SELLING",
    "PRODUCT.PRICE.COST",
    "PRODUCT.TAX_PERCENT",
    "PRODUCT.STATUS",
    "PRODUCT.INVENTORY",
    "PRODUCT.LABELS",
    "PRODUCT.CATEGORY",
    "PRODUCT.TAGS",
    "PRODUCT.IMAGES",
  ] as const,

  OPTION_HEADER_NAMES: [
    "NAME",
    "TYPE",
    "ENABLE_RANGE",
    "RANGE",
    "REQUIRED",
    "VIEW",
    "VARIANTS",
  ] as const,
};
