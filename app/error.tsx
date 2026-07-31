"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] Unhandled error:", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#212121] flex items-center justify-center p-6">
      <div className="bg-[#2f2f2f] border border-white/10 rounded-2xl p-8 max-w-md w-full text-center">
        <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center">
          <i className="fas fa-triangle-exclamation text-red-400"></i>
        </div>
        <h1 className="text-white font-semibold mb-2">Something went wrong</h1>
        <p className="text-sm text-slate-400 mb-6">
          The app hit an unexpected error. Your draft is safe — try again.
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 rounded-lg bg-white/10 text-white text-sm font-medium hover:bg-white/20 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
