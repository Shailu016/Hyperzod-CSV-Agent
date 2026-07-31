import fs from "fs";
import path from "path";

/**
 * Environment key discovery. Precedence:
 * 1. process.env — set by next.config.js/.env loading (local) or
 *    the Vercel dashboard (production). This is the only path that
 *    works in production — no filesystem access is assumed there.
 * 2. <cwd>/.env — local development convenience.
 *
 * This project is fully self-contained: all keys live in its own .env.
 */
export function discoverKey(varName: string): string | null {
  const fromEnv = process.env[varName];
  if (fromEnv) return fromEnv;

  try {
    const localEnv = path.join(process.cwd(), ".env");
    const content = fs.readFileSync(localEnv, "utf-8");
    for (const line of content.split("\n")) {
      const re = new RegExp(`^${varName}\\s*=\\s*(.+?)\\s*$`);
      const match = line.match(re);
      if (match) {
        const val = match[1].trim().replace(/^["']|["']$/g, "");
        if (val) return val;
      }
    }
  } catch {
    /* .env not present */
  }
  return null;
}
