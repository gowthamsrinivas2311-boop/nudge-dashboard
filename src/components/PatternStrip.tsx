import { useMemo } from "react";

interface PatternStripProps {
  /** All orders for this customer+item, sorted chronologically */
  history: {
    id: number;
    quantity: number;
    status: string;
  }[];
  /** The order ID to highlight as "current" */
  currentOrderId: number;
  /** Reference average line value */
  referenceAvg?: number;
}

/**
 * Inline SVG sparkline that shows a customer's order-quantity history
 * for a single item. The current order is highlighted with a larger dot.
 * Flagged orders render in --rust, normal in --ledger-teal.
 */
export default function PatternStrip({
  history,
  currentOrderId,
  referenceAvg,
}: PatternStripProps) {
  const { points, avgY, viewBox } = useMemo(() => {
    if (history.length === 0) return { points: [], avgY: 0, viewBox: "0 0 200 40" };

    const maxQty = Math.max(...history.map((h) => h.quantity), 1);
    const w = 200;
    const h = 36;
    const padY = 4;

    const pts = history.map((order, i) => {
      const x = history.length === 1 ? w / 2 : (i / (history.length - 1)) * (w - 8) + 4;
      const y = padY + h - (order.quantity / maxQty) * h;
      return { ...order, x, y };
    });

    const aY = referenceAvg != null ? padY + h - (referenceAvg / maxQty) * h : 0;

    return { points: pts, avgY: aY, viewBox: `0 0 ${w} ${h + padY * 2}` };
  }, [history, referenceAvg]);

  if (history.length === 0) {
    return (
      <div
        style={{ background: "var(--ink)", borderRadius: 2, padding: "8px 0" }}
        className="font-mono-num"
      >
        <span style={{ color: "var(--muted)", fontSize: 10 }}>No history</span>
      </div>
    );
  }

  // Build the polyline path
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  return (
    <div style={{ background: "var(--ink)", borderRadius: 2, padding: "6px 8px" }}>
      <svg
        viewBox={viewBox}
        width="100%"
        height="44"
        preserveAspectRatio="none"
        style={{ display: "block" }}
      >
        {/* Reference average dashed line */}
        {referenceAvg != null && avgY > 0 && (
          <line
            x1="0"
            y1={avgY}
            x2="200"
            y2={avgY}
            stroke="var(--brass)"
            strokeWidth="0.8"
            strokeDasharray="3 3"
            opacity="0.6"
          />
        )}

        {/* Connecting line */}
        <path
          d={linePath}
          fill="none"
          stroke="var(--muted)"
          strokeWidth="1.2"
          opacity="0.35"
        />

        {/* Dots */}
        {points.map((p) => {
          const isCurrent = p.id === currentOrderId;
          const isFlagged = p.status === "flagged" || p.status === "rejected";
          const dotColor = isFlagged ? "var(--rust)" : "var(--ledger-teal)";
          const r = isCurrent ? 4 : 2;

          return (
            <circle
              key={p.id}
              cx={p.x}
              cy={p.y}
              r={r}
              fill={isCurrent ? dotColor : "none"}
              stroke={dotColor}
              strokeWidth={isCurrent ? 0 : 1.2}
            />
          );
        })}
      </svg>
    </div>
  );
}
