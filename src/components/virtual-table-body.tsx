import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type VirtualTableBodyProps<T> = {
  items: T[];
  rowHeight?: number;
  overscan?: number;
  /** Render one data row (already a <tr>). */
  renderRow: (item: T, index: number) => ReactNode;
  /** Optional empty state row(s). */
  empty?: ReactNode;
  className?: string;
};

/**
 * Lightweight windowed tbody for large tables. Keeps only visible rows mounted.
 * Parent must be the vertical scroll container (or pass scrollRef via nesting).
 */
export function VirtualTableBody<T>({
  items,
  rowHeight = 36,
  overscan = 8,
  renderRow,
  empty,
  className,
}: VirtualTableBodyProps<T>) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLTableSectionElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;

    // Find nearest vertical scroll parent
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      const style = getComputedStyle(node);
      const oy = style.overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") break;
      node = node.parentElement;
    }
    const scroller = node ?? document.documentElement;
    scrollRef.current = scroller;

    const update = () => {
      const sc = scrollRef.current;
      if (!sc || !sentinelRef.current) return;
      const scRect = sc === document.documentElement
        ? { top: 0, height: window.innerHeight }
        : sc.getBoundingClientRect();
      const bodyRect = sentinelRef.current.getBoundingClientRect();
      const offsetTop = bodyRect.top - scRect.top + (sc === document.documentElement ? 0 : sc.scrollTop);
      // distance from scroll top to tbody top
      const scrollTop = sc === document.documentElement ? window.scrollY : sc.scrollTop;
      const viewTop = Math.max(0, scrollTop - offsetTop + (sc === document.documentElement ? 0 : 0));
      // Simpler: use intersection of tbody with scroller viewport
      const relTop = Math.max(0, scRect.top - bodyRect.top);
      const visible = scRect.height;
      const start = Math.max(0, Math.floor(relTop / rowHeight) - overscan);
      const end = Math.min(
        items.length,
        Math.ceil((relTop + visible) / rowHeight) + overscan
      );
      setRange((prev) =>
        prev.start === start && prev.end === end ? prev : { start, end }
      );
      void viewTop;
    };

    update();
    const target: HTMLElement | Window =
      scroller === document.documentElement ? window : scroller;
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [items.length, rowHeight, overscan]);

  const slice = useMemo(() => {
    if (items.length === 0) return [];
    return items.slice(range.start, range.end);
  }, [items, range.end, range.start]);

  if (items.length === 0) {
    return <tbody className={className}>{empty}</tbody>;
  }

  const topPad = range.start * rowHeight;
  const bottomPad = Math.max(0, (items.length - range.end) * rowHeight);
  // colspan is unknown; use a single full-width spacer via style height on tr
  const colSpan = 12;

  return (
    <tbody ref={sentinelRef} className={className}>
      {topPad > 0 && (
        <tr aria-hidden style={{ height: topPad }}>
          <td colSpan={colSpan} style={{ padding: 0, border: 0, height: topPad }} />
        </tr>
      )}
      {slice.map((item, i) => renderRow(item, range.start + i))}
      {bottomPad > 0 && (
        <tr aria-hidden style={{ height: bottomPad }}>
          <td colSpan={colSpan} style={{ padding: 0, border: 0, height: bottomPad }} />
        </tr>
      )}
    </tbody>
  );
}
