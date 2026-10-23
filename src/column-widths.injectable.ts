import { getInjectable2 } from "@k8slens/injectable";
import { getPersistableMapInjectableBunch } from "@k8slens/persistable-contracts";
import { action, observable, type ObservableMap, runInAction } from "mobx";

export type ResizableColumn = "date" | "pod" | "namespace" | "cluster";

export const defaultColumnWidths: Readonly<Record<ResizableColumn, number>> = { date: 196, cluster: 140, namespace: 140, pod: 240 };

const minWidths: Readonly<Record<ResizableColumn, number>> = { date: 150, cluster: 60, namespace: 60, pod: 80 };

export const columnTitles: Readonly<Record<ResizableColumn, string>> = { date: "Date", cluster: "Cluster", namespace: "Namespace", pod: "Pod" };

const resizableColumns = Object.keys(defaultColumnWidths) as ResizableColumn[];

/** How tall the histogram is drawn, by default and at the most and least it can be dragged to. */
export const histogramHeights = { default: 64, min: 40, max: 360 } as const;

const histogramKey = "histogram-height";

// Hidden columns are kept in the same map as the widths, under their own key.
const hiddenKeyOf = (column: ResizableColumn) => `hidden:${column}`;

/** How wide the user dragged each column of the log table, and which ones they hid, kept across restarts for every tab. */
export const columnWidthsBunch = getPersistableMapInjectableBunch<string, number>()({
  id: "column-widths",
});

export const columnWidthsInjectable = getInjectable2({
  id: "logs-aggregator-column-widths",

  instantiate: (di) => {
    const getWidths = di.inject(columnWidthsBunch.persistable);
    const stored = observable.box<ObservableMap<string, number> | undefined>(undefined, { deep: false });
    const dragging = observable.map<ResizableColumn, number>();
    const draggingHistogram = observable.box<number | undefined>(undefined);
    const clampHistogram = (height: number) => Math.min(histogramHeights.max, Math.max(histogramHeights.min, Math.round(height)));

    void getWidths().then((loaded) => runInAction(() => stored.set(loaded)));

    const value = {
      widthOf: (column: ResizableColumn) =>
        Math.max(minWidths[column], dragging.get(column) ?? stored.get()?.get(column) ?? defaultColumnWidths[column]),
      /** While dragging only the screen follows; the width is kept once the drag ends. */
      drag: action((column: ResizableColumn, width: number) => dragging.set(column, Math.max(minWidths[column], Math.round(width)))),
      commit: action((column: ResizableColumn) => {
        const width = dragging.get(column);

        if (width !== undefined) {
          stored.get()?.set(column, width);
          dragging.delete(column);
        }
      }),
      reset: action((column: ResizableColumn) => {
        dragging.delete(column);
        stored.get()?.delete(column);
      }),
      isHidden: (column: ResizableColumn) => stored.get()?.has(hiddenKeyOf(column)) ?? false,
      hidden: () => resizableColumns.filter((column) => stored.get()?.has(hiddenKeyOf(column))),
      hide: action((column: ResizableColumn) => stored.get()?.set(hiddenKeyOf(column), 1)),
      showAll: action(() => resizableColumns.forEach((column) => stored.get()?.delete(hiddenKeyOf(column)))),
      /** The histogram's height, dragged by its bottom edge and kept like the widths. */
      histogramHeight: () => draggingHistogram.get() ?? stored.get()?.get(histogramKey) ?? histogramHeights.default,
      dragHistogram: action((height: number) => draggingHistogram.set(clampHistogram(height))),
      commitHistogram: action(() => {
        const height = draggingHistogram.get();

        if (height !== undefined) {
          stored.get()?.set(histogramKey, height);
          draggingHistogram.set(undefined);
        }
      }),
      resetHistogram: action(() => {
        draggingHistogram.set(undefined);
        stored.get()?.delete(histogramKey);
      }),
    };

    return () => value;
  },
});
