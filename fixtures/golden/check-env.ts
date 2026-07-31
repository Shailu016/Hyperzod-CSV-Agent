import { discoverKey } from "../../lib/env";

console.log("GEMINI:", discoverKey("GEMINI_API_KEY") ? "FOUND" : "MISSING");
console.log("DEEPSEEK:", discoverKey("DEEPSEEK_API_KEY") ? "FOUND" : "MISSING");
