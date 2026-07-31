# Hyperzod CSV Agent

AI-powered CSV product catalog builder for Hyperzod stores. Describe products in plain English, preview the data, and export a Hyperzod-compliant import file.

## Features

- **Chat-to-CSV**: Describe products naturally — "5 t-shirts, 3 sizes, ₹499 each, 4 colors"
- **CSV Upload & Edit**: Drag-drop an existing Hyperzod CSV and prompt-edit it ("increase all prices 10%")
- **Live Preview Grid**: Edit any cell by hand, see validation errors inline, confidence flags for AI-inferred values
- **Multi-level Options**: Supports Hyperzod nested add-ons (variants → sub-options) with correct `{}/();,` DSL syntax
- **Dual AI**: Uses Gemini 3.6 Flash with automatic fallback to DeepSeek V4

## Quick Start

```bash
npm install
# Create .env with GEMINI_API_KEY (from bountystrike/.env)
npm run dev
```

Open http://localhost:3000

## Tech

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- Zod validation
- Gemini 3.6 Flash / DeepSeek V4 (auto-fallback)
