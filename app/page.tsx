"use client";

import { useState, useCallback, useRef } from "react";
import ChatPanel from "@/components/chat/ChatPanel";
import ProductGrid from "@/components/grid/ProductGrid";
import type { Product } from "@/lib/schema";
import type { ValidationResult } from "@/lib/validator";
import { parseCSV } from "@/lib/parser";
import { validateProducts } from "@/lib/validator";

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runValidation = useCallback((prods: Product[]) => {
    const result = validateProducts(prods);
    setValidation(result);
  }, []);

  const handleProductsUpdate = useCallback(
    (
      newProducts: Product[],
      _assistantMessage: string,
      _clarifyingQuestion?: string
    ) => {
      setProducts(newProducts);
      runValidation(newProducts);
    },
    [runValidation]
  );

  const handleManualProductsChange = useCallback(
    (updated: Product[]) => {
      setProducts(updated);
      runValidation(updated);
    },
    [runValidation]
  );

  const handleStatusChange = useCallback(
    (newStatus: "idle" | "loading" | "error") => {
      setStatus(newStatus);
    },
    []
  );

  const handleFileUpload = async (file: File) => {
    setCsvFileName(file.name);
    try {
      const text = await file.text();
      const parsed = parseCSV(text);
      setProducts(parsed);
      runValidation(parsed);
    } catch {
      setCsvFileName(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove("border-violet-400", "bg-violet-500/10");
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".csv")) {
      handleFileUpload(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.add("border-violet-400", "bg-violet-500/10");
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove("border-violet-400", "bg-violet-500/10");
  };

  const handleReset = useCallback(() => {
    setProducts([]);
    setValidation(null);
    setCsvFileName(null);
    setStatus("idle");
  }, []);

  const handleExport = async () => {
    if (products.length === 0) return;
    setExporting(true);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(products),
      });

      if (!res.ok) throw new Error("Export failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `hyperzod_import_${Date.now()}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const readinessText =
    products.length === 0
      ? "No products yet"
      : validation?.valid
        ? `${products.length} product${products.length > 1 ? "s" : ""} ready to export`
        : `${products.length} product${products.length > 1 ? "s" : ""}, ${validation?.errorCount ?? 0} issue${(validation?.errorCount ?? 1) > 1 ? "s" : ""} need review`;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top Bar */}
      <header className="h-14 shrink-0 bg-slate-950/95 border-b border-white/10 flex items-center justify-between px-6 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-violet-500/25">
            <i className="fas fa-wand-magic-sparkles text-xs text-white"></i>
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">
              Hyperzod CSV Agent
            </h1>
          </div>
          {csvFileName && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-slate-400 border border-white/10">
              <i className="fas fa-file-csv mr-1 text-violet-400"></i>
              {csvFileName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                status === "loading"
                  ? "bg-amber-400 animate-pulse"
                  : status === "error"
                    ? "bg-red-400"
                    : validation?.valid
                      ? "bg-emerald-400"
                      : "bg-amber-400"
              }`}
            ></span>
            <span className="text-slate-400">{readinessText}</span>
          </div>

          {products.length > 0 && (
            <button
              onClick={handleExport}
              disabled={exporting}
              className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-600 text-white text-xs font-semibold hover:shadow-lg hover:shadow-emerald-500/25 transition-all disabled:opacity-50"
            >
              {exporting ? (
                <i className="fas fa-spinner fa-spin mr-1.5"></i>
              ) : (
                <i className="fas fa-download mr-1.5"></i>
              )}
              Export CSV
            </button>
          )}

          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 text-xs hover:bg-white/10 hover:text-white transition-colors"
          >
            <i className="fas fa-upload mr-1.5"></i>
            Upload CSV
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileUpload(file);
            }}
          />
        </div>
      </header>

      {/* Split Pane */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat Panel */}
        <div className="w-[420px] shrink-0 border-r border-white/10 flex flex-col bg-slate-950/50">
          <ChatPanel
            products={products}
            onProductsUpdate={handleProductsUpdate}
            onStatusChange={handleStatusChange}
            onReset={handleReset}
          />
        </div>

        {/* Right: Product Grid */}
        <div
          className="flex-1 flex flex-col bg-slate-950/30 overflow-hidden"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between shrink-0">
            <div>
              <h2 className="text-sm font-semibold text-white">
                Product Preview
              </h2>
              {products.length > 0 && (
                <p className="text-[10px] text-slate-500 mt-0.5">
                  Click any cell to edit directly. Blue cells are AI-inferred
                  and need review.
                </p>
              )}
            </div>

            {validation && (
              <div className="flex items-center gap-3 text-[11px]">
                {validation.errorCount > 0 && (
                  <span className="flex items-center gap-1 text-red-400">
                    <i className="fas fa-circle-exclamation text-xs"></i>
                    {validation.errorCount} error
                    {validation.errorCount > 1 ? "s" : ""}
                  </span>
                )}
                {validation.warningCount > 0 && (
                  <span className="flex items-center gap-1 text-amber-400">
                    <i className="fas fa-triangle-exclamation text-xs"></i>
                    {validation.warningCount} warning
                    {validation.warningCount > 1 ? "s" : ""}
                  </span>
                )}
              </div>
            )}
          </div>

          {products.length === 0 && (
            <div
              className="flex-1 flex flex-col items-center justify-center p-8 border-2 border-dashed border-white/10 rounded-xl m-6 cursor-pointer hover:border-violet-500/40 hover:bg-violet-500/5 transition-all"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="w-16 h-16 mb-4 rounded-2xl bg-slate-800/80 border border-white/10 flex items-center justify-center">
                <i className="fas fa-cloud-arrow-up text-2xl text-slate-600"></i>
              </div>
              <p className="text-slate-400 text-sm mb-1">
                Drag & drop an existing CSV to edit it
              </p>
              <p className="text-slate-600 text-xs">
                Or describe your products in the chat pane
              </p>
            </div>
          )}

          {products.length > 0 && (
            <ProductGrid
              products={products}
              validation={validation}
              onProductsChange={handleManualProductsChange}
            />
          )}
        </div>
      </div>
    </div>
  );
}
