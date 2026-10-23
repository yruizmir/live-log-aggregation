import { Div } from "@k8slens/element-components";
import { observer } from "mobx-react";
import { useRef, useState } from "react";
import { useInject } from "@k8slens/use-inject";
import { columnWidthsInjectable } from "../column-widths.injectable";
import type { HistogramBucket, Session } from "../session.injectable";
import { dateTime, shortTime } from "./format";

const stackOrder = ["debug", "info", "warn", "error"] as const;
const legendNames = { error: "Error", warn: "Warning", info: "Info", debug: "Debug" } as const;
const ticks = [1, 2, 3, 4, 5, 6, 7].map((index) => index / 8);

/**
 * The volume of the lines over the read window, stacked by level, the way Datadog draws it above
 * its list. Dragging across it narrows the list to that stretch of time; a double click lets go.
 */
export const Histogram = observer(({ session }: { readonly session: Session }) => {
  const buckets = session.histogram.get();
  const range = session.timeRange.get();
  const area = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | undefined>(undefined);
  const [hovered, setHovered] = useState<number | undefined>(undefined);
  const sizes = useInject(columnWidthsInjectable)();
  const resizeFrom = useRef<{ y: number; height: number } | undefined>(undefined);
  const highest = Math.max(1, ...buckets.map((bucket) => bucket.total));

  if (buckets.length === 0) {
    return null;
  }

  const indexAt = (clientX: number) => {
    const rect = area.current?.getBoundingClientRect();

    if (!rect || rect.width === 0) {
      return 0;
    }

    return Math.min(buckets.length - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * buckets.length)));
  };

  /** The bar under the pointer: the one hovered, or by position while a drag holds the pointer. */
  const indexOf = (event: React.PointerEvent) => {
    const column = (event.target as HTMLElement).closest?.("[data-index]");

    return column ? Number(column.getAttribute("data-index")) : indexAt(event.clientX);
  };

  const selected = (index: number) => {
    if (drag) {
      return index >= Math.min(drag.from, drag.to) && index <= Math.max(drag.from, drag.to);
    }

    return range ? buckets[index].end > range.from && buckets[index].start < range.to : true;
  };

  const shown = hovered !== undefined ? buckets[hovered] : undefined;
  const completeFrom = session.completeFrom.get();
  const windowStart = buckets[0].start;
  const windowEnd = buckets.at(-1)!.end;
  // Only the empty stretch before the first bar: past it there are lines, even if some container has older ones.
  const firstWithLines = buckets.find((bucket) => bucket.total > 0);
  const unreadUntil = completeFrom === undefined || !firstWithLines ? undefined : Math.min(completeFrom, firstWithLines.start);
  const unreadShare = unreadUntil === undefined ? 0 : Math.min(1, Math.max(0, (unreadUntil - windowStart) / (windowEnd - windowStart)));
  const narrowedToResource = session.scope.get().sources.length > 0;
  const format = (timestamp: number) => (session.windowSeconds.get() > 6 * 3600 ? dateTime.format(timestamp) : shortTime.format(timestamp));

  return (
    <Div $className="la-hist">
      <div className="la-hist-legend">
        {[...stackOrder].reverse().filter((level) => buckets.some((bucket) => bucket.counts[level] > 0)).map((level) => (
          <span key={level} className="la-hist-legend-item">
            <span className={`la-hist-legend-swatch la-hist-seg--${level}`} />
            {legendNames[level]}
          </span>
        ))}
      </div>
      <div
        ref={area}
        style={{ height: sizes.histogramHeight() }}
        className="la-hist-bars"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const index = indexOf(event);

          setDrag({ from: index, to: index });
        }}
        onPointerMove={(event) => {
          const index = drag ? indexAt(event.clientX) : indexOf(event);

          setHovered(index);

          if (drag) {
            setDrag({ ...drag, to: index });
          }
        }}
        onPointerLeave={() => setHovered(undefined)}
        onPointerUp={() => {
          if (drag) {
            const from = Math.min(drag.from, drag.to);
            const to = Math.max(drag.from, drag.to);

            // A drag zooms into the bars it crossed; a click, into the one clicked, when it has lines.
            if (to > from || buckets[from].total > 0) {
              session.setTimeRange({ from: buckets[from].start, to: buckets[to].end });
            }

            setDrag(undefined);
          }
        }}
        onDoubleClick={() => session.setTimeRange(undefined)}
      >
        {buckets.map((bucket, index) => (
          <div key={bucket.start} data-index={index} className={`la-hist-col${selected(index) ? "" : " la-hist-col--out"}${hovered === index ? " la-hist-col--hover" : ""}`}>
            {stackOrder.map((level) =>
              bucket.counts[level] > 0 ? (
                <div key={level} className={`la-hist-seg la-hist-seg--${level}`} style={{ height: `${(bucket.counts[level] / highest) * 100}%` }} />
              ) : null,
            )}
          </div>
        ))}
        {unreadShare > 0 && (
          <div className="la-hist-unread" style={{ width: `${unreadShare * 100}%` }}>
            {unreadShare > 0.3 && (
              <span className="la-hist-unread-label">
                Not read before {format(unreadUntil!)}:{" "}
                {narrowedToResource
                  ? "more lines than are read for a workload or pod (30,000 per container, 100,000 in all)."
                  : "only the newest lines of each container are read. Pick a workload or pod in Resources to read further back."}
              </span>
            )}
          </div>
        )}
        {shown && hovered !== undefined && <Tooltip bucket={shown} at={(hovered + 0.5) / buckets.length} />}
      </div>
      <div className="la-hist-axis">
        {ticks.map((fraction) => (
          <span key={fraction} className="la-hist-tick" style={{ left: `${fraction * 100}%` }}>
            {format(buckets[0].start + fraction * (buckets.at(-1)!.end - buckets[0].start))}
          </span>
        ))}
      </div>
      <div
        className="la-hist-resize"
        title="Drag to make the chart taller or shorter; double click for the default"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeFrom.current = { y: event.clientY, height: sizes.histogramHeight() };
        }}
        onPointerMove={(event) => {
          if (resizeFrom.current) {
            sizes.dragHistogram(resizeFrom.current.height + event.clientY - resizeFrom.current.y);
          }
        }}
        onPointerUp={() => {
          resizeFrom.current = undefined;
          sizes.commitHistogram();
        }}
        onDoubleClick={() => sizes.resetHistogram()}
      />
    </Div>
  );
});

const Tooltip = ({ bucket, at }: { readonly bucket: HistogramBucket; readonly at: number }) => (
  <div
    className="la-hist-tip"
    // Above the bar it is about, kept inside the chart at both ends.
    style={{ left: `${at * 100}%`, transform: `translateX(${at < 0.15 ? "0" : at > 0.85 ? "-100%" : "-50%"})` }}
  >
    <b>{shortTime.format(bucket.start)}</b> · {bucket.total.toLocaleString()} lines
    {bucket.counts.error > 0 && <span className="la-hist-tip-error"> · {bucket.counts.error} errors</span>}
    {bucket.counts.warn > 0 && <span className="la-hist-tip-warn"> · {bucket.counts.warn} warnings</span>}
  </div>
);
