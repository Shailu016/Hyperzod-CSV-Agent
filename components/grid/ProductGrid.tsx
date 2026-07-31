"use client";

import { useState, useMemo, useRef } from "react";
import type { Product, ProductOption, ProductVariant } from "@/lib/schema";
import type { ValidationResult, ValidationIssue } from "@/lib/validator";

interface ProductGridProps {
  products: Product[];
  validation: ValidationResult | null;
  onProductsChange: (products: Product[]) => void;
}

export default function ProductGrid({
  products,
  validation,
  onProductsChange,
}: ProductGridProps) {
  const [editingCell, setEditingCell] = useState<{
    row: number;
    field: string;
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<{ row: number; field: string } | null>(null);

  const issueMap = useMemo(() => {
    const map = new Map<string, ValidationIssue[]>();
    if (!validation) return map;
    for (const issue of [...validation.errors, ...validation.warnings]) {
      const key = `${issue.rowIndex}:${issue.field}`;
      const list = map.get(key);
      if (list) list.push(issue);
      else map.set(key, [issue]);
    }
    return map;
  }, [validation]);

  const handleCellClick = (rowIndex: number, field: string, value: unknown) => {
    setEditingCell({ row: rowIndex, field });
    editRef.current = { row: rowIndex, field };
    setEditValue(value != null ? String(value) : "");
  };

  const commitCell = (rowIndex: number, field: string) => {
    if (!editRef.current || editRef.current.row !== rowIndex || editRef.current.field !== field) {
      return;
    }
    const updated = [...products];
    const product = { ...updated[rowIndex] };

    if (field === "sellingPrice" || field === "costPrice" || field === "taxPercent") {
      const parsed = parseFloat(editValue);
      if (editValue.trim() === "" || isNaN(parsed)) {
        // Invalid input — revert, don't clobber with 0
        editRef.current = null;
        setEditingCell(null);
        return;
      }
      (product as Record<string, unknown>)[field] = parsed;
    } else if (field === "inventory") {
      const parsed = parseInt(editValue, 10);
      if (editValue.trim() === "" || isNaN(parsed)) {
        editRef.current = null;
        setEditingCell(null);
        return;
      }
      (product as Record<string, unknown>)[field] = parsed;
    } else {
      (product as Record<string, unknown>)[field] = editValue;
    }

    (product._fieldConfidence as Record<string, string>)[field] = "stated";

    updated[rowIndex] = product;
    onProductsChange(updated);
    editRef.current = null;
    setEditingCell(null);
  };

  const cancelEdit = () => {
    editRef.current = null;
    setEditingCell(null);
  };

  const handleCellKeyDown = (
    e: React.KeyboardEvent,
    rowIndex: number,
    field: string
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCell(rowIndex, field);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const getIssues = (rowIndex: number, field: string): ValidationIssue[] => {
    return issueMap.get(`${rowIndex}:${field}`) || [];
  };

  if (products.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-800/80 border border-white/10 flex items-center justify-center">
            <i className="fas fa-table text-2xl text-slate-600"></i>
          </div>
          <p className="text-slate-400 text-sm">
            Describe the products you want in the chat pane, or upload a CSV to
            get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10">
          <tr className="bg-slate-950/90 backdrop-blur-sm">
            <th className="text-left p-3 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
              #
            </th>
            <th className="text-left p-3 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
              Name
            </th>
            <th className="text-left p-3 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
              SKU
            </th>
            <th className="text-left p-3 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
              Category
            </th>
            <th className="text-right p-3 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
              Selling Price
            </th>
            <th className="text-right p-3 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
              Cost Price
            </th>
            <th className="text-center p-3 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
              Status
            </th>
            <th className="text-left p-3 text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
              Options
            </th>
          </tr>
        </thead>
        <tbody>
          {products.map((p, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-b border-white/5 hover:bg-white/[0.02] transition-colors"
            >
              <td className="p-3 text-slate-500 font-mono text-xs">
                {rowIndex + 1}
              </td>
              <td className="p-3">
                <EditableCell
                  value={p.name}
                  isEditing={
                    editingCell?.row === rowIndex &&
                    editingCell?.field === "name"
                  }
                  editValue={
                    editingCell?.row === rowIndex &&
                    editingCell?.field === "name"
                      ? editValue
                      : ""
                  }
                  confidence={
                    (
                      p._fieldConfidence as Record<string, string>
                    )?.["name"] as string | undefined
                  }
                  issues={getIssues(rowIndex, "name")}
                  onEdit={() => handleCellClick(rowIndex, "name", p.name)}
                  onChange={(v) => setEditValue(v)}
                  onSave={() => commitCell(rowIndex, "name")}
                  onKeyDown={(e) => handleCellKeyDown(e, rowIndex, "name")}
                />
              </td>
              <td className="p-3 font-mono text-xs text-slate-400">
                {p.sku || (
                  <span className="text-slate-600 italic">No SKU</span>
                )}
              </td>
              <td className="p-3">
                <span className="px-2 py-0.5 rounded-md bg-white/5 text-xs text-slate-300 border border-white/10">
                  {p.category || (
                    <span className="text-red-400 italic">Missing</span>
                  )}
                </span>
              </td>
              <td className="p-3 text-right">
                <EditableCell
                  value={`₹${p.sellingPrice.toFixed(2)}`}
                  isEditing={
                    editingCell?.row === rowIndex &&
                    editingCell?.field === "sellingPrice"
                  }
                  editValue={
                    editingCell?.row === rowIndex &&
                    editingCell?.field === "sellingPrice"
                      ? editValue
                      : ""
                  }
                  issues={getIssues(rowIndex, "sellingPrice")}
                  onEdit={() =>
                    handleCellClick(
                      rowIndex,
                      "sellingPrice",
                      p.sellingPrice
                    )
                  }
                  onChange={(v) => setEditValue(v)}
                  onSave={() => commitCell(rowIndex, "sellingPrice")}
                  onKeyDown={(e) =>
                    handleCellKeyDown(e, rowIndex, "sellingPrice")
                  }
                  className="text-emerald-400 font-semibold"
                />
              </td>
              <td className="p-3 text-right">
                <EditableCell
                  value={p.costPrice != null ? `₹${p.costPrice.toFixed(2)}` : "—"}
                  isEditing={
                    editingCell?.row === rowIndex &&
                    editingCell?.field === "costPrice"
                  }
                  editValue={
                    editingCell?.row === rowIndex &&
                    editingCell?.field === "costPrice"
                      ? editValue
                      : ""
                  }
                  issues={getIssues(rowIndex, "costPrice")}
                  onEdit={() =>
                    handleCellClick(rowIndex, "costPrice", p.costPrice ?? "")
                  }
                  onChange={(v) => setEditValue(v)}
                  onSave={() => commitCell(rowIndex, "costPrice")}
                  onKeyDown={(e) =>
                    handleCellKeyDown(e, rowIndex, "costPrice")
                  }
                  className="text-slate-300"
                />
              </td>
              <td className="p-3 text-center">
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                    p.status === "active"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                      : "bg-slate-500/10 text-slate-400 border-slate-500/30"
                  }`}
                >
                  {p.status.toUpperCase()}
                </span>
              </td>
              <td className="p-3">
                <OptionsSummary options={p.options ?? []} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditableCell({
  value,
  isEditing,
  editValue,
  confidence,
  issues,
  onEdit,
  onChange,
  onSave,
  onKeyDown,
  className = "",
}: {
  value: string;
  isEditing: boolean;
  editValue: string;
  confidence?: string;
  issues?: ValidationIssue[];
  onEdit: () => void;
  onChange: (v: string) => void;
  onSave: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  className?: string;
}) {
  if (isEditing) {
    return (
      <input
        value={editValue}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onSave}
        onKeyDown={onKeyDown}
        autoFocus
        className="bg-slate-800 border border-white/30 rounded-md px-2 py-1 text-sm text-white w-full focus:outline-none focus:border-white/50"
      />
    );
  }

  return (
    <div className="relative group cursor-pointer" onClick={onEdit}>
      <span className={className}>{value}</span>
      {confidence === "inferred" && (
        <span className="ml-1 px-1 py-0.5 rounded text-[9px] bg-amber-500/15 text-amber-500/80 border border-amber-500/20">
          inferred
        </span>
      )}
      {issues &&
        issues.map((issue, i) => (
          <span
            key={i}
            className={`ml-1 px-1 py-0.5 rounded text-[9px] ${
              issue.message.startsWith("Image URL uses HTTP")
                ? "bg-amber-500/15 text-amber-500/80 border border-amber-500/20"
                : "bg-red-500/15 text-red-400 border border-red-500/20"
            }`}
            title={issue.message}
          >
            {issue.message.split(" — ")[0].slice(0, 30)}
          </span>
        ))}
    </div>
  );
}

function OptionsSummary({ options }: { options: ProductOption[] }) {
  const [expanded, setExpanded] = useState(false);

  if (options.length === 0) {
    return <span className="text-slate-600 italic text-xs">None</span>;
  }

  return (
    <div className="text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-neutral-400 hover:text-neutral-300 transition-colors"
      >
        {options.length} option{options.length > 1 ? "s" : ""}{" "}
        <i
          className={`fas fa-chevron-${expanded ? "down" : "right"} text-[9px]`}
        ></i>
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5 pl-2 border-l border-white/10">
          {options.map((opt, i) => (
            <div key={i}>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-300 font-medium">{opt.name}</span>
                <span className="text-[10px] px-1 rounded bg-white/10 text-slate-400">
                  {opt.type.toUpperCase()}
                </span>
                {opt.required && (
                  <span className="text-[10px] text-amber-400">Required</span>
                )}
              </div>
              <div className="text-slate-500 mt-0.5">
                {(opt.variants || []).length} variant
                {(opt.variants || []).length !== 1 ? "s" : ""}
                {(opt.variants || []).slice(0, 3).map((v: ProductVariant, j: number) => (
                  <div key={j} className="flex items-center gap-1 text-[11px] mt-0.5">
                    <span className="text-slate-400">- {v.name}</span>
                    {v.price > 0 && (
                      <span className="text-emerald-500/80">
                        +₹{v.price.toFixed(2)}
                      </span>
                    )}
                    {v.nestedOptions && v.nestedOptions.length > 0 && (
                      <span className="text-neutral-500/70">
                        ({v.nestedOptions.length} add-on
                        {v.nestedOptions.length > 1 ? "s" : ""})
                      </span>
                    )}
                  </div>
                ))}
                {(opt.variants || []).length > 3 && (
                  <div className="text-slate-600 text-[10px]">
                    +{(opt.variants || []).length - 3} more
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
