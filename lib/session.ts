import type { Product } from "./schema";

/**
 * Session state — derived from the conversation each turn, injected into
 * the model so it remembers the TASK, not just the last message.
 *
 * No client changes needed: everything is rebuilt server-side from the
 * history array the client already sends.
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SessionState {
  /** The persistent task the user is executing (first substantive message). */
  goal: string | null;
  /** Number of products currently loaded. */
  productCount: number;
  /** Snippet of the last assistant turn (what was done last). */
  lastAction: string | null;
  /** True when the last assistant message was a question (answer in flight). */
  pendingClarification: boolean;
  /** 1-based count of user turns including this one. */
  turnNumber: number;
  /** True when this message references/continues the ongoing task. */
  continuation: boolean;
  /** Deepest option nesting level in the catalog (1 = flat, 2+ = nested add-ons). */
  catalogDepth: number;
  /** Total variant count across all loaded products. */
  totalVariants: number;
}

const TRIVIAL_RE =
  /^(ok|okay|k|kk|fine|good|great|nice|done|yes|yep|yup|no|nope|thanks|thank you|thx|ty|awesome|perfect|sure|alright|right|understood|cool|got it|i see|hmm|haha|lol|that'?s (fine|good|great|ok)|sounds good|no problem|thank you so much|thanks a lot)\s*[.!]*$/i;

/** A message that carries actual task content (not filler). */
export function isSubstantiveMessage(content: string): boolean {
  const c = content.trim();
  if (!c) return false;
  if (c.length <= 60 && TRIVIAL_RE.test(c)) return false;
  return true;
}

function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max
    ? `${clean.slice(0, max - 1).trimEnd()}…`
    : clean;
}

export function deriveSessionState(
  history: ChatTurn[],
  prompt: string,
  products: Product[]
): SessionState {
  const userTurns = history.filter((m) => m.role === "user");

  const firstTask = userTurns.find((m) => isSubstantiveMessage(m.content));
  const goal = firstTask ? shorten(firstTask.content, 120) : null;

  const lastAssistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant");
  const lastAction = lastAssistant
    ? shorten(lastAssistant.content, 180)
    : null;
  const pendingClarification =
    !!lastAssistant && /[?？]\s*$/.test(lastAssistant.content.trim());

  const trimmedPrompt = prompt.trim();
  const continuation =
    /^(also|and|then|now|plus|next|again|same|additionally)\b/i.test(
      trimmedPrompt
    ) ||
    /\b(also|as well|too|additionally|and then|same way|keep going)\b/i.test(
      prompt
    ) ||
    /\b(what about)\b/i.test(prompt);

  let catalogDepth = 0;
  let totalVariants = 0;
  const walkOptions = (opts: Product["options"], depth: number): void => {
    for (const o of opts || []) {
      catalogDepth = Math.max(catalogDepth, depth);
      for (const v of o.variants || []) {
        totalVariants++;
        walkOptions(v.nestedOptions, depth + 1);
      }
    }
  };
  walkOptions(products.flatMap((p) => p.options || []), 1);

  return {
    goal,
    productCount: products.length,
    lastAction,
    pendingClarification,
    turnNumber: userTurns.length + 1,
    continuation,
    catalogDepth,
    totalVariants,
  };
}

/** Compact multi-line block injected into the model's user message. */
export function sessionBlock(s: SessionState): string {
  const lines = ["SESSION (derived from conversation):"];
  if (s.goal) lines.push(`- Task in progress: "${s.goal}"`);
  lines.push(`- Products loaded: ${s.productCount}`);
  if (s.lastAction) lines.push(`- Last action: "${s.lastAction}"`);
  lines.push(
    `- Turn: ${s.turnNumber}${
      s.continuation
        ? " — this message CONTINUES the task above (same context)"
        : " — new instruction"
    }`
  );
  return lines.join("\n");
}
