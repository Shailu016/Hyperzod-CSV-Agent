"use client";

import { useState, useRef, useEffect } from "react";
import type { BrainResponse, Product } from "@/lib/schema";
import AgentActivity from "@/components/AgentActivity";

interface ChatPanelProps {
  products: Product[];
  onProductsUpdate: (
    products: Product[],
    assistantMessage: string,
    clarifyingQuestion?: string
  ) => void;
  onStatusChange: (status: "idle" | "loading" | "error") => void;
  onReset: () => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  clarifyingQuestion?: string;
  timestamp: number;
}

export default function ChatPanel({
  products,
  onProductsUpdate,
  onStatusChange,
  onReset,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Describe the products you want — a whole collection, or just one item. You can also upload an existing CSV to edit it.",
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    onStatusChange("loading");

    setMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed, timestamp: Date.now() },
    ]);

    setInput("");

    try {
      const history = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await fetch("/api/brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          currentProducts: products,
          history,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || err.error || "Request failed");
      }

      const data: BrainResponse = await res.json();

      onProductsUpdate(
        data.products,
        data.assistantMessage,
        data.clarifyingQuestion
      );

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.assistantMessage,
          clarifyingQuestion: data.clarifyingQuestion,
          timestamp: Date.now(),
        },
      ]);

      onStatusChange("idle");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${msg}`,
          timestamp: Date.now(),
        },
      ]);
      onStatusChange("error");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const quickPrompts = [
    "Create 5 pizza products with size options (Small/Medium/Large) and topping add-ons, ₹299-₹599 each",
    "Create 10 grocery items for organic store with multi-select add-ons",
    "Make all products 15% cheaper",
    "Mark all products as inactive",
    "Create 3 t-shirts with color and size variants, ₹899 each",
    "Add a 'Large' variant to all existing products",
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-white/10 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center text-white">
          <i className="fas fa-wand-magic-sparkles text-sm"></i>
        </div>
        <div className="flex-1">
          <h2 className="font-bold text-sm text-white">CSV Agent</h2>
          <p className="text-xs text-slate-400">
            Describe products, get a ready-to-import CSV
          </p>
        </div>
        <button
          onClick={() => {
            setMessages([
              {
                role: "assistant",
                content:
                  "Describe the products you want — a whole collection, or just one item. You can also upload an existing CSV to edit it.",
                timestamp: Date.now(),
              },
            ]);
            onReset();
          }}
          title="New chat"
          className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center"
        >
          <i className="fas fa-plus text-xs"></i>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((msg, i) => (
          <ChatBubble key={i} message={msg} />
        ))}
        {loading && <AgentActivity active={loading} />}
        <div ref={messagesEndRef} />
      </div>

      <div className="px-3 pb-2">
        <div className="flex gap-1.5 flex-wrap mb-2">
          <span className="text-[10px] text-slate-500 self-center">
            Quick:
          </span>
          {quickPrompts.slice(0, 4).map((qp, i) => (
            <button
              key={i}
              onClick={() => setInput(qp)}
              className="text-[10px] px-2 py-1 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 hover:text-white hover:border-white/30 transition-colors"
            >
              {qp.length > 55 ? qp.slice(0, 55) + "..." : qp}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your products..."
            rows={2}
            className="flex-1 bg-slate-900/70 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-white/30 focus:shadow-[0_0_15px_rgba(255,255,255,0.05)]"
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-4 rounded-xl bg-white/10 text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/20 transition-all"
          >
            {loading ? (
              <i className="fas fa-spinner fa-spin"></i>
            ) : (
              <i className="fas fa-paper-plane"></i>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] rounded-2xl px-4 py-3 ${
          isUser
            ? "bg-white/10 border border-white/20 text-white"
            : "bg-slate-800/60 border border-white/10 text-slate-200"
        }`}
      >
        {!isUser && (
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-5 h-5 rounded-md bg-white/10 flex items-center justify-center">
              <i className="fas fa-robot text-[10px] text-white"></i>
            </div>
            <span className="text-[10px] font-semibold text-white/60 uppercase tracking-wider">
              CSV Agent
            </span>
          </div>
        )}
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {message.content}
        </p>
        {message.clarifyingQuestion && (
          <div className="mt-2 p-2 bg-white/5 border border-white/10 rounded-lg">
            <p className="text-xs text-white/60">
              {message.clarifyingQuestion}
            </p>
          </div>
        )}
        <span className="text-[10px] text-slate-500 mt-1.5 block">
          {new Date(message.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
    </div>
  );
}
