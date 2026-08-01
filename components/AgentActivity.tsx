"use client";

import { useEffect, useState } from "react";

interface AgentActivityProps {
  active: boolean;
}

const STEPS = [
  "Understanding your request",
  "Generating product data",
  "Normalizing & validating",
  "Preparing your catalog",
];

/**
 * Inline typing indicator shown in the chat thread while the agent works.
 * Steps appear one at a time, like ChatGPT's tool-use display — no box,
 * it flows like a message.
 */
export default function AgentActivity({ active }: AgentActivityProps) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (active) {
      setStepIndex(0);
      const interval = setInterval(() => {
        setStepIndex((prev) => Math.min(prev + 1, STEPS.length - 1));
      }, 3500);
      return () => clearInterval(interval);
    }
  }, [active]);

  if (!active) return null;

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl px-4 py-3 bg-slate-800/60 border border-white/10 text-slate-200">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-5 h-5 rounded-md bg-white/10 flex items-center justify-center">
            <i className="fas fa-robot text-[10px] text-white"></i>
          </div>
          <span className="text-[10px] font-semibold text-white/60 uppercase tracking-wider">
            CSV Agent
          </span>
        </div>
        <div className="space-y-1.5">
          {STEPS.slice(0, stepIndex + 1).map((step, idx) => {
            const isCurrent = idx === stepIndex;
            const isDone = idx < stepIndex;
            return (
              <div key={step} className="flex items-center gap-2">
                {isDone ? (
                  <i className="fas fa-circle-check text-[11px] text-emerald-400 w-3.5 text-center"></i>
                ) : (
                  <i className="fas fa-circle-notch fa-spin text-[11px] text-white/60 w-3.5 text-center"></i>
                )}
                <span className={`text-xs ${isCurrent ? "text-white" : "text-slate-400"}`}>
                  {step}
                </span>
              </div>
            );
          })}
        </div>
        {/* Typing dots while the last step is in progress */}
        <div className="flex items-center gap-1 mt-2 pl-5">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]"></span>
          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]"></span>
          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]"></span>
        </div>
      </div>
    </div>
  );
}
