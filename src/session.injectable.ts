import { getInjectable2 } from "@k8slens/injectable";
import { getPersistableMapInjectableBunch } from "@k8slens/persistable-contracts";
import { action, computed, observable, type ObservableMap, reaction, runInAction, when } from "mobx";
import { clustersInjectable } from "./clusters.injectable";
import {
  fetchLogsInjectable,
  type LogTarget,
  readInventoryInjectable,
  readWarningEventsInjectable,
  resolveSelectorInjectable,
} from "./kubectl.injectable";
import { clauseMatches, facetSelections, highlightTerms, isFacetClause, parseQuery, setFacetInQuery } from "./query";
import {
  type Alarm,
  contextOf,
  emptyScope,
  firstLineOf,
  type FacetFilter,
  type FacetKey,
  limits,
  type LogLevel,
  type LogLine,
  type LogSource,
  messageOf,
  messageShape,
  phraseOf,
  type PodInfo,
  type ResourceRef,
  type Scope,
  sourceGroupKey,
  sourceKey,
  type SourceKind,
  sourceKinds,
} from "./model";

/** What each tab reads, kept across restarts. */
export const tabScopesBunch = getPersistableMapInjectableBunch<string, Scope>()({
  id: "tab-scopes",
});

/** How each tab was being explored: filters, facets and view, kept across restarts. */
export interface Exploration {
  readonly level: LevelFilter;
  readonly windowSeconds: number;
  /** How often Live reads again; absent in tabs saved before it could be chosen. */
  readonly liveIntervalSeconds?: number;
  readonly query: string;
  readonly useRegex: boolean;
  readonly view: View;
  readonly facets: Readonly<Record<string, FacetFilter>>;
}

export const tabExplorationsBunch = getPersistableMapInjectableBunch<string, Exploration>()({
  id: "tab-explorations",
});

interface ReadResult {
  readonly loading: boolean;
  readonly lines: readonly LogLine[];
  readonly unreadable: number;
  readonly problems: readonly string[];
  /** The window the lines were read for; a different window means reading them all again. */
  readonly windowSeconds: number;
  /**
   * Containers whose lines filled the --tail of the read, each with the oldest line it gave:
   * before that, the container has lines that were not read.
   */
  readonly cutAt?: ReadonlyMap<string, number>;
}

/** The key of a cut that applies to every container of its read. */
const everyContainer = "*";

const containerKeyOf = (line: LogLine) => `${line.clusterId}|${line.namespace}|${line.pod}|${line.container}`;

/** The containers that gave as many lines as asked for: their older lines were left out. */
const cutsOf = (lines: readonly LogLine[], tailLines: number) => {
  const counts = new Map<string, { count: number; oldest: number }>();

  for (const line of lines) {
    if (line.event || line.previous) {
      continue;
    }

    const key = containerKeyOf(line);
    const seen = counts.get(key);

    counts.set(key, { count: (seen?.count ?? 0) + 1 + (line.continuation ?? 0), oldest: Math.min(seen?.oldest ?? line.timestamp, line.timestamp) });
  }

  return new Map([...counts].filter(([, { count }]) => count >= tailLines).map(([key, { oldest }]) => [key, oldest]));
};

interface Inventory {
  readonly loading: boolean;
  readonly pods: readonly PodInfo[];
  readonly error?: string;
}

interface Coverage {
  readonly podsRead: number;
  readonly podsTotal: number;
}

export type LevelFilter = "all" | "warn" | "error";
export type View = "timeline" | "patterns" | "alarms";
export type Picker = "cluster" | "namespace" | "source" | "time" | "live" | "options";

/** A resource the user can narrow to, as the pickers offer it: the same one across clusters is one row. */
export interface SourceCandidate {
  readonly kind: SourceKind;
  readonly namespace: string;
  readonly name: string;
  readonly clusterIds: readonly string[];
  readonly pods: number;
}

const levelRank: Record<LogLevel, number> = { debug: 0, info: 0, warn: 1, error: 2 };

export interface FacetValue {
  readonly value: string;
  readonly count: number;
}

export interface Facet {
  readonly key: FacetKey;
  readonly label: string;
  readonly values: readonly FacetValue[];
  readonly total: number;
}

export interface HistogramBucket {
  readonly start: number;
  readonly end: number;
  readonly counts: Readonly<Record<LogLevel, number>>;
  readonly total: number;
}

export interface Pattern {
  readonly shape: string;
  readonly count: number;
  readonly level: LogLevel;
  readonly sample: LogLine;
  readonly pods: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly series: readonly number[];
}

export interface TimeRange {
  readonly from: number;
  readonly to: number;
}

const histogramBuckets = 60;
const patternBuckets = 20;
const maxFieldFacets = 12;
const maxFieldCardinality = 50;
const fieldsLeftOutOfFacets = new Set(["msg", "message", "error", "err", "stack", "stacktrace", "caller", "trace_id", "span_id"]);

const fixedFacets: readonly { readonly key: FacetKey; readonly label: string }[] = [
  { key: "level", label: "Level" },
  { key: "cluster", label: "Cluster" },
  { key: "namespace", label: "Namespace" },
  { key: "workload", label: "Workload" },
  { key: "pod", label: "Pod" },
  { key: "container", label: "Container" },
  { key: "run", label: "Run" },
];

const shapes = new WeakMap<LogLine, string>();

/** The pattern a line belongs to: its message with what varies taken out, worked out once. */
export const patternOf = (line: LogLine) => {
  let shape = shapes.get(line);

  if (shape === undefined) {
    shape = messageShape(firstLineOf(messageOf(line)));
    shapes.set(line, shape);
  }

  return shape;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A line by its first line only, so a stack trace read in two halves across refreshes is one line. */
const lineIdentity = (line: LogLine) =>
  `${line.clusterId}|${line.namespace}|${line.pod}|${line.container}|${line.time}|${firstLineOf(line.message)}${line.previous ? "|previous" : ""}`;

/** Of two reads of the same line, the one with more of its trace joined. */
const longer = (left: LogLine, right: LogLine) => ((right.continuation ?? 0) > (left.continuation ?? 0) ? right : left);

/** Lines read before and lines read now, as one list without repeats and within the window. */
const mergeLines = (previous: readonly LogLine[], fresh: readonly LogLine[], oldest: number) => {
  const at = new Map<string, number>();
  const lines: LogLine[] = [];

  for (const line of [...previous, ...fresh]) {
    if (line.timestamp < oldest) {
      continue;
    }

    const identity = lineIdentity(line);
    const index = at.get(identity);

    if (index === undefined) {
      at.set(identity, lines.length);
      lines.push(line);
    } else {
      lines[index] = longer(lines[index], line);
    }
  }

  // Oldest first, so that past the lines kept it is the oldest that go, whichever container they are of.
  return lines.length > limits.maxLinesKept
    ? [...lines].sort((left, right) => left.timestamp - right.timestamp).slice(-limits.maxLinesKept)
    : lines;
};

const trouble = (pod: PodInfo) => (pod.ready || pod.phase === "Succeeded" ? 0 : 10) + Math.min(pod.restarts, 10);

/**
 * One tab's aggregation: what it reads, what the user narrowed it to, the lines and the alarms
 * in them. It reads everything unless told otherwise, and only while the tab is attached
 * (rendered), so a closed or hidden tab costs the clusters nothing.
 */
export const sessionInjectable = getInjectable2({
  id: "logs-aggregator-session",

  instantiate: (di) => {
    const clusters = di.inject(clustersInjectable)();
    const fetchLogs = di.inject(fetchLogsInjectable)();
    const readInventory = di.inject(readInventoryInjectable)();
    const readWarningEvents = di.inject(readWarningEventsInjectable)();
    const resolveSelector = di.inject(resolveSelectorInjectable)();
    const getTabScopes = di.inject(tabScopesBunch.persistable);
    const getTabExplorationsOnce = di.inject(tabExplorationsBunch.persistable);

    return (tabId: string) => {
      const persisted = observable.box<ObservableMap<string, Scope> | undefined>(undefined, { deep: false });

      void getTabScopes().then((loaded) => runInAction(() => persisted.set(loaded)));

      const scope = computed((): Required<Scope> => {
        const stored = persisted.get()?.get(tabId) ?? emptyScope;

        return { clusterIds: stored.clusterIds, namespaces: stored.namespaces ?? [], sources: stored.sources };
      });
      const setScope = action((next: Partial<Scope>) => persisted.get()?.set(tabId, { ...scope.get(), ...next }));

      const query = observable.box("");
      const useRegex = observable.box(false);
      const caseSensitive = observable.box(false);
      const newestFirst = observable.box(true);
      const showFacets = observable.box(false);
      const level = observable.box<LevelFilter>("all");
      const windowSeconds = observable.box<number>(300);
      const live = observable.box(false);
      const liveIntervalSeconds = observable.box<number>(limits.liveIntervalMs / 1000);
      const view = observable.box<View>("timeline");
      const reads = observable.map<string, ReadResult>({}, { deep: false });
      const inventories = observable.map<string, Inventory>({}, { deep: false });
      const coverage = observable.map<string, Coverage>({}, { deep: false });
      const plannedReads = observable.box<ReadonlySet<string>>(new Set(), { deep: false });
      const loadedAt = observable.box<number | undefined>(undefined);
      const reading = observable.box(false);
      const now = observable.box(Date.now());

      const timeRange = observable.box<TimeRange | undefined>(undefined, { deep: false });
      const selectedLineId = observable.box<string | undefined>(undefined);
      const previousNotice = observable.box<string | undefined>(undefined);

      const picker = observable.box<Picker | undefined>(undefined, { deep: false });
      const pickerQuery = observable.box("");

      let attachments = 0;
      let liveTimer: ReturnType<typeof setInterval> | undefined;
      let clockTimer: ReturnType<typeof setInterval> | undefined;
      let generation = 0;

      const isNarrowed = computed(() => scope.get().namespaces.length > 0 || scope.get().sources.length > 0);

      /** The clusters read: the ones picked, or every connected one when none are. */
      const clusterIds = computed(() => {
        const picked = scope.get().clusterIds;

        if (picked.length > 0) {
          return picked;
        }

        return clusters.clusters
          .get()
          .filter((cluster) => cluster.isConnected.get())
          .map((cluster) => cluster.id)
          .slice(0, limits.maxClusters);
      });

      const ownerOfPod = computed(() => {
        const owners = new Map<string, PodInfo>();

        for (const [, inventory] of inventories) {
          for (const pod of inventory.pods) {
            owners.set(`${pod.clusterId}|${pod.namespace}|${pod.name}`, pod);
          }
        }

        return owners;
      });

      const readKeyOf = (clusterId: string, part: string) => `${clusterId}|${part}`;

      /** Lines per container: more when narrowed, and most for a workload or a pod over a long window. */
      const tailLines = (narrowed: "resource" | "namespace" | false) =>
        windowSeconds.get() > 3600
          ? narrowed === "resource"
            ? limits.tailLinesWhenResourceLong
            : narrowed ? limits.tailLinesWhenNarrowedLong : limits.tailLinesWhenAllLong
          : narrowed ? limits.tailLinesWhenNarrowed : limits.tailLinesWhenAll;

      /**
       * The run of a container before its last restart, read once per restart: it does not change
       * until the container restarts again, and it is where a crash says why.
       */
      const readPrevious = async (current: number, key: string, clusterId: string, pod: PodInfo, container: string) => {
        // Read once per restart, even when it came back empty.
        if (reads.has(key)) {
          return reads.get(key)!.lines.length;
        }

        runInAction(() => reads.set(key, { loading: true, lines: [], unreadable: 0, problems: [], windowSeconds: windowSeconds.get() }));

        try {
          const fetched = await fetchLogs(
            clusterId,
            { namespace: pod.namespace, pod: pod.name, container, previous: true },
            { seconds: 0 },
            limits.tailLinesPrevious,
          );

          runInAction(() =>
            current === generation || current === -1
              ? reads.set(key, { loading: false, lines: fetched.lines, unreadable: 0, problems: fetched.problems, windowSeconds: windowSeconds.get() })
              : reads.delete(key),
          );

          return fetched.lines.length;
        } catch (error) {
          runInAction(() =>
            reads.set(key, { loading: false, lines: [], unreadable: 0, problems: [(error as Error).message], windowSeconds: windowSeconds.get() }),
          );

          return 0;
        }
      };

      const previousKeyOf = (clusterId: string, pod: PodInfo, container: string, restarts: number) =>
        readKeyOf(clusterId, `previous|${pod.namespace}|${pod.name}|${container}|${restarts}`);

      /** Previous runs the user asked for, kept read across refreshes. */
      const askedPrevious = observable.set<string>();

      const readOne = async (
        current: number,
        key: string,
        clusterId: string,
        target: LogTarget,
        tailLines: number,
      ) => {
        const previous = reads.get(key);
        const window = windowSeconds.get();
        const incremental = previous && previous.windowSeconds === window && previous.lines.length > 0;
        const lastLine = incremental ? previous.lines.at(-1) : undefined;
        const since = lastLine ? { time: new Date(lastLine.timestamp - 1000).toISOString() } : { seconds: window };

        runInAction(() => reads.set(key, { ...(previous ?? { lines: [], unreadable: 0, problems: [] }), loading: true, windowSeconds: window }));

        try {
          const fetched = await fetchLogs(clusterId, target, since, tailLines);

          if (current !== generation) {
            return;
          }

          const lines = mergeLines(incremental ? previous.lines : [], fetched.lines, Date.now() - window * 1000);
          // A full read says where each container was cut; Live's reads of what is new keep that.
          const cutAt = new Map(incremental ? previous.cutAt : cutsOf(fetched.lines, tailLines));

          // Past the lines kept, the oldest went for every container of the read.
          if (lines.length >= limits.maxLinesKept) {
            cutAt.set(everyContainer, lines[0].timestamp);
          }

          runInAction(() =>
            reads.set(key, {
              loading: false,
              lines,
              unreadable: fetched.unreadable.length,
              problems: fetched.problems,
              windowSeconds: window,
              cutAt,
            }),
          );
        } catch (error) {
          if (current === generation) {
            runInAction(() =>
              reads.set(key, { loading: false, lines: previous?.lines ?? [], unreadable: 0, problems: [(error as Error).message], windowSeconds: window }),
            );
          }
        }
      };

      const readEvents = async (current: number, clusterId: string) => {
        const key = readKeyOf(clusterId, "events");
        const previous = reads.get(key);
        const window = windowSeconds.get();

        runInAction(() => reads.set(key, { ...(previous ?? { lines: [], unreadable: 0, problems: [] }), loading: true, windowSeconds: window }));

        try {
          const lines = await readWarningEvents(clusterId, window);

          if (current === generation) {
            runInAction(() => reads.set(key, { loading: false, lines, unreadable: 0, problems: [], windowSeconds: window }));
          }
        } catch (error) {
          if (current === generation) {
            runInAction(() =>
              reads.set(key, { loading: false, lines: [], unreadable: 0, problems: [(error as Error).message], windowSeconds: window }),
            );
          }
        }
      };

      /** Runs the reads of one cluster a few at a time, so no cluster gets a burst of requests. */
      const inTurns = async (tasks: readonly (() => Promise<void>)[]) => {
        const queue = [...tasks];
        const worker = async (): Promise<void> => {
          const task = queue.shift();

          if (task) {
            await task();
            await worker();
          }
        };

        await Promise.all(Array.from({ length: limits.concurrentReadsPerCluster }, worker));
      };

      const readCluster = async (current: number, clusterId: string, planned: Set<string>) => {
        let pods: readonly PodInfo[];

        runInAction(() => inventories.set(clusterId, { loading: true, pods: inventories.get(clusterId)?.pods ?? [] }));

        try {
          pods = await readInventory(clusterId);
          runInAction(() => inventories.set(clusterId, { loading: false, pods }));
        } catch (error) {
          runInAction(() => inventories.set(clusterId, { loading: false, pods: [], error: (error as Error).message }));

          return;
        }

        if (current !== generation) {
          return;
        }

        const { namespaces, sources } = scope.get();
        const tasks: (() => Promise<void>)[] = [() => readEvents(current, clusterId)];

        planned.add(readKeyOf(clusterId, "events"));

        const sourcesHere = sources.filter((source) => source.clusterId === clusterId);

        if (sourcesHere.length > 0) {
          for (const source of sourcesHere) {
            const key = readKeyOf(clusterId, `source|${sourceKey(source)}`);

            planned.add(key);
            tasks.push(async () => {
              let selector = source.selector;

              if (source.kind !== "Pod" && !selector) {
                try {
                  selector = await resolveSelector(clusterId, source.kind, source.namespace, source.name);
                  runInAction(() =>
                    setScope({
                      sources: scope.get().sources.map((candidate) =>
                        sourceKey(candidate) === sourceKey(source) ? { ...candidate, selector } : candidate,
                      ),
                    }),
                  );
                } catch (error) {
                  runInAction(() =>
                    reads.set(key, { loading: false, lines: [], unreadable: 0, problems: [(error as Error).message], windowSeconds: windowSeconds.get() }),
                  );

                  return;
                }
              }

              await readOne(
                current,
                key,
                clusterId,
                source.kind === "Pod" ? { namespace: source.namespace, pod: source.name } : { namespace: source.namespace, selector },
                tailLines("resource"),
              );
            });
          }

          runInAction(() => coverage.delete(clusterId));
        } else if (sources.length === 0) {
          // Every namespace, or the ones picked; with nothing picked, the pods in trouble go first
          // and the reading stops at the pod budget, so a big cluster is never read whole.
          const podsByNamespace = new Map<string, PodInfo[]>();

          for (const pod of pods) {
            if (namespaces.length === 0 || namespaces.includes(pod.namespace)) {
              podsByNamespace.set(pod.namespace, [...(podsByNamespace.get(pod.namespace) ?? []), pod]);
            }
          }

          const ordered = [...podsByNamespace.entries()].sort(
            ([, left], [, right]) =>
              right.reduce((sum, pod) => sum + trouble(pod), 0) - left.reduce((sum, pod) => sum + trouble(pod), 0),
          );
          const capped = namespaces.length === 0;
          let podsRead = 0;

          for (const [namespace, namespacePods] of ordered) {
            if (capped && podsRead > 0 && podsRead + namespacePods.length > limits.maxPodsPerCluster) {
              continue;
            }

            podsRead += namespacePods.length;

            const key = readKeyOf(clusterId, `namespace|${namespace}`);

            planned.add(key);
            tasks.push(() =>
              readOne(
                current,
                key,
                clusterId,
                { namespace },
                tailLines(isNarrowed.get() ? "namespace" : false),
              ),
            );
          }

          const podsTotal = [...podsByNamespace.values()].reduce((sum, list) => sum + list.length, 0);

          runInAction(() => coverage.set(clusterId, { podsRead, podsTotal }));
        }

        // Containers that crashed: their previous run holds the reason, so it is read too.
        const inScope = (pod: PodInfo) =>
          (namespaces.length === 0 || namespaces.includes(pod.namespace)) &&
          (sources.length === 0 ||
            sources.some(
              (source) =>
                source.clusterId === clusterId &&
                source.namespace === pod.namespace &&
                (source.kind === "Pod" ? source.name === pod.name : source.kind === pod.owner.kind && source.name === pod.owner.name),
            ));
        const crashed = pods
          .filter(inScope)
          .flatMap((pod) =>
            pod.containers
              .filter(
                (container) =>
                  container.restarts > 0 &&
                  (/CrashLoopBackOff|Error/.test(container.waitingReason ?? "") || /OOMKilled|Error/.test(container.lastReason ?? "")),
              )
              .map((container) => ({ pod, container })),
          )
          .sort((left, right) => right.container.restarts - left.container.restarts)
          .slice(0, limits.maxPreviousReadsPerCluster);

        for (const { pod, container } of crashed) {
          const key = previousKeyOf(clusterId, pod, container.name, container.restarts);

          planned.add(key);
          tasks.push(async () => void (await readPrevious(current, key, clusterId, pod, container.name)));
        }

        for (const key of askedPrevious) {
          if (key.startsWith(`${clusterId}|`)) {
            planned.add(key);
          }
        }

        await inTurns(tasks);
      };

      const refresh = async () => {
        // The tab's clusters, namespaces and resources load from disk: reading before them would
        // read what the tab was not asked for, and show nothing of what it was.
        await when(() => persisted.get() !== undefined);

        const current = ++generation;
        const planned = new Set<string>();

        runInAction(() => reading.set(true));

        await Promise.all(clusterIds.get().map((clusterId) => readCluster(current, clusterId, planned)));

        if (current === generation) {
          runInAction(() => {
            plannedReads.set(planned);

            for (const key of [...reads.keys()]) {
              if (!planned.has(key)) {
                reads.delete(key);
              }
            }

            loadedAt.set(Date.now());
            now.set(Date.now());
            reading.set(false);
          });
        }
      };

      const startLive = () => {
        liveTimer ??= setInterval(() => void refresh(), liveIntervalSeconds.get() * 1000);
      };

      const stopLive = () => {
        if (liveTimer) {
          clearInterval(liveTimer);
          liveTimer = undefined;
        }
      };

      /** Lines and events of the reads that belong to what the tab reads now. */
      const merged = computed(() => {
        const planned = plannedReads.get();
        const { namespaces, sources } = scope.get();
        const lines: LogLine[] = [];
        const seen = new Map<string, number>();
        const owners = ownerOfPod.get();

        const eventInScope = (line: LogLine) => {
          if (namespaces.length > 0 && !namespaces.includes(line.namespace)) {
            return false;
          }

          if (sources.length === 0) {
            return true;
          }

          const owner = owners.get(`${line.clusterId}|${line.namespace}|${line.pod}`)?.owner;

          return sources.some(
            (source) =>
              source.clusterId === line.clusterId &&
              source.namespace === line.namespace &&
              ((source.kind === line.event?.involvedKind && source.name === line.pod) ||
                (owner?.kind === source.kind && owner.name === source.name)),
          );
        };

        for (const [key, result] of reads) {
          if (planned.size > 0 && !planned.has(key) && !result.loading) {
            continue;
          }

          for (const line of result.lines) {
            if (line.event && !eventInScope(line)) {
              continue;
            }

            const identity = lineIdentity(line);
            const index = seen.get(identity);

            if (index === undefined) {
              seen.set(identity, lines.length);
              lines.push(line);
            } else {
              lines[index] = longer(lines[index], line);
            }
          }
        }

        return lines.sort((left, right) => left.timestamp - right.timestamp);
      });

      const resourceOfLine = (line: LogLine): ResourceRef => {
        const pod = ownerOfPod.get().get(`${line.clusterId}|${line.namespace}|${line.pod}`);

        if (line.event && line.event.involvedKind !== "Pod") {
          return { clusterId: line.clusterId, kind: line.event.involvedKind, namespace: line.namespace, name: line.pod };
        }

        return pod
          ? { clusterId: line.clusterId, kind: pod.owner.kind, namespace: line.namespace, name: pod.owner.name }
          : { clusterId: line.clusterId, kind: "Pod", namespace: line.namespace, name: line.pod };
      };

      /** Errors in the logs and Warning events, grouped by resource and by what they say. */
      const alarms = computed(() => {
        const groups = new Map<string, { first: LogLine; lines: LogLine[]; resource: ResourceRef; count: number }>();

        for (const line of merged.get()) {
          if (!line.event && line.level !== "error") {
            continue;
          }

          const resource = resourceOfLine(line);
          const what = line.event ? `event|${line.event.reason}` : `log|${messageShape(firstLineOf(messageOf(line)))}`;
          const key = `${resource.clusterId}|${resource.kind}|${resource.namespace}|${resource.name}|${what}`;
          const group = groups.get(key) ?? { first: line, lines: [], resource, count: 0 };

          group.lines.push(line);
          group.count += line.event ? line.event.count : 1;
          groups.set(key, group);
        }

        return [...groups.entries()]
          .map(([id, { first, lines, resource, count }]): Alarm => {
            const latest = lines.at(-1) ?? first;

            return {
              id,
              origin: first.event ? "event" : "log",
              level: lines.some((line) => line.level === "error") ? "error" : "warn",
              clusterId: resource.clusterId,
              resource,
              pod: latest.event?.involvedKind === "Pod" || !latest.event ? latest.pod : undefined,
              message: latest.message,
              reason: latest.event?.reason,
              count,
              firstSeen: latest.event ? Date.parse(latest.event.firstSeen) : first.timestamp,
              lastSeen: latest.timestamp,
              event: latest.event,
              lines,
            };
          })
          .sort((left, right) => levelRank[right.level] - levelRank[left.level] || right.lastSeen - left.lastSeen);
      });

      const clusterNameToId = computed(() => new Map(clusters.clusters.get().map((cluster) => [clusters.nameOf(cluster.id), cluster.id])));
      const toQuery = (key: FacetKey, value: string) => (key === "cluster" ? clusters.nameOf(value) : value);
      const fromQuery = (key: FacetKey, value: string) => (key === "cluster" ? clusterNameToId.get().get(value) ?? value : value);

      /** The search box read as the query language, unless it holds a regular expression. */
      const parsed = computed(() => (useRegex.get() ? { clauses: [], problems: [] } : parseQuery(query.get())));

      const selections = computed(() => facetSelections(parsed.get().clauses, fromQuery));

      const facetFilters = {
        get: (key: FacetKey) => selections.get().get(key),
        has: (key: FacetKey) => selections.get().has(key),
        keys: () => selections.get().keys(),
        entries: () => selections.get().entries(),
      };

      const matcher = computed(() => {
        const text = query.get().trim();

        if (!text) {
          return undefined;
        }

        if (!useRegex.get()) {
          const terms = highlightTerms(parsed.get().clauses);

          return terms.length > 0 ? new RegExp(terms.map(escapeRegExp).join("|"), caseSensitive.get() ? "g" : "gi") : undefined;
        }

        try {
          return new RegExp(text, caseSensitive.get() ? "g" : "gi");
        } catch {
          return null;
        }
      });

      const searchableText = new WeakMap<LogLine, string>();
      const searchableOf = (line: LogLine) => {
        let text = searchableText.get(line);

        if (text === undefined) {
          text = `${line.message}\n${line.pod}/${line.container}`.toLowerCase();
          searchableText.set(line, text);
        }

        return text;
      };

      /** Every filter but the facets, the time range and below `minimum` the level. */
      const filterLines = (minimum: number) => {
        const pattern = useRegex.get() ? matcher.get() : undefined;
        const clauses = parsed.get().clauses.filter((clause) => !isFacetClause(clause));
        const resolver = { valueOf: facetValueOf, toQuery };
        // The query language matches in any case; with Aa on, its free words must match as written.
        const exactTerms = caseSensitive.get() && !useRegex.get() ? highlightTerms(clauses) : [];

        return merged.get().filter((line) => {
          if (levelRank[line.level] < minimum) {
            return false;
          }

          if (pattern === null) {
            return false;
          }

          if (pattern) {
            pattern.lastIndex = 0;

            return pattern.test(line.message) || pattern.test(`${line.pod}/${line.container}`);
          }

          if (exactTerms.length > 0 && !exactTerms.every((term) => line.message.includes(term) || `${line.pod}/${line.container}`.includes(term))) {
            return false;
          }

          return clauses.every((clause) => clauseMatches(clause, line, searchableOf, resolver));
        });
      };

      const minimumLevel = () => (level.get() === "error" ? 2 : level.get() === "warn" ? 1 : 0);

      /** Every filter but the facets and the time range: the base the facet counts are taken from. */
      const baseFiltered = computed(() => filterLines(minimumLevel()));

      const workloadOf = (line: LogLine) => {
        const resource = resourceOfLine(line);

        return `${resource.kind} ${resource.name}`;
      };

      const facetValueOf = (key: FacetKey, line: LogLine): string | undefined => {
        switch (key) {
          case "level":
            return line.level;
          case "cluster":
            return line.clusterId;
          case "namespace":
            return line.namespace;
          case "workload":
            return workloadOf(line);
          case "pod":
            return line.pod;
          case "container":
            return line.container;
          case "run":
            return line.previous ? "previous" : "current";
          default:
            return line.fields?.[key.slice("field:".length)];
        }
      };

      const passesFacet = (key: FacetKey, filter: FacetFilter, line: LogLine) => {
        const value = facetValueOf(key, line)?.toLowerCase();
        // Typed by hand, a value may differ in case from how the lines have it.
        const has = (list: readonly string[]) => value !== undefined && list.some((candidate) => candidate.toLowerCase() === value);

        if (filter.include.length > 0 && !has(filter.include)) {
          return false;
        }

        return !has(filter.exclude);
      };

      const activeFacets = computed(() =>
        [...selections.get().entries()].filter(([, filter]) => filter.include.length > 0 || filter.exclude.length > 0),
      );

      const inRange = (line: LogLine) => {
        const range = timeRange.get();

        return !range || line.previous === true || (line.timestamp >= range.from && line.timestamp < range.to);
      };

      /** The base with the facets applied: what the histogram draws, before its own range. */
      const facetFiltered = computed(() => {
        const active = activeFacets.get();

        return active.length === 0
          ? baseFiltered.get()
          : baseFiltered.get().filter((line) => active.every(([key, filter]) => passesFacet(key, filter, line)));
      });

      const filtered = computed(() => (timeRange.get() ? facetFiltered.get().filter(inRange) : facetFiltered.get()));

      /** How many lines each level button would show, with every other filter applied. */
      const levelCounts = computed(() => {
        const active = activeFacets.get().filter(([key]) => key !== "level");
        const counts = { all: 0, warn: 0, error: 0 };

        for (const line of filterLines(0)) {
          if (!inRange(line) || !active.every(([key, filter]) => passesFacet(key, filter, line))) {
            continue;
          }

          counts.all++;
          counts.warn += levelRank[line.level] >= 1 ? 1 : 0;
          counts.error += levelRank[line.level] >= 2 ? 1 : 0;
        }

        return counts;
      });

      /** The structured fields worth a facet: common enough, and with few enough values to pick from. */
      const fieldKeys = computed(() => {
        const lines = baseFiltered.get();
        const stats = new Map<string, { present: number; values: Set<string>; length: number }>();

        for (const line of lines) {
          if (!line.fields) {
            continue;
          }

          for (const [key, value] of Object.entries(line.fields)) {
            if (fieldsLeftOutOfFacets.has(key.toLowerCase())) {
              continue;
            }

            const stat = stats.get(key) ?? { present: 0, values: new Set<string>(), length: 0 };

            stat.present++;
            stat.length += value.length;

            if (stat.values.size <= maxFieldCardinality) {
              stat.values.add(value);
            }

            stats.set(key, stat);
          }
        }

        const wanted = new Set(
          [...facetFilters.keys()].filter((key) => key.startsWith("field:")).map((key) => key.slice("field:".length)),
        );
        const common = [...stats.entries()]
          .filter(
            ([key, stat]) =>
              wanted.has(key) ||
              (stat.present >= Math.max(2, lines.length * 0.05) &&
                stat.values.size > 1 &&
                stat.values.size <= maxFieldCardinality &&
                stat.length / stat.present <= 80),
          )
          .sort(([, left], [, right]) => right.present - left.present)
          .map(([key]) => key);

        return [...new Set([...wanted, ...common])].slice(0, maxFieldFacets + wanted.size);
      });

      /**
       * Each facet's values with how many lines have them, counted the way Datadog does: with every
       * other facet applied but not the facet's own selection, so its other values stay pickable.
       */
      const facets = computed((): readonly Facet[] => {
        const keys: { key: FacetKey; label: string }[] = [
          ...fixedFacets,
          ...fieldKeys.get().map((field) => ({ key: `field:${field}` as FacetKey, label: field })),
        ];
        const active = activeFacets.get();
        const counts = new Map<FacetKey, Map<string, number>>(keys.map(({ key }) => [key, new Map()]));

        for (const line of baseFiltered.get()) {
          if (!inRange(line)) {
            continue;
          }

          const failing = active.filter(([key, filter]) => !passesFacet(key, filter, line)).map(([key]) => key);

          if (failing.length > 1) {
            continue;
          }

          for (const { key } of keys) {
            if (failing.length === 1 && failing[0] !== key) {
              continue;
            }

            const value = facetValueOf(key, line);

            if (value !== undefined) {
              const values = counts.get(key)!;

              values.set(value, (values.get(value) ?? 0) + 1);
            }
          }
        }

        return keys
          .map(({ key, label }) => {
            const values = [...(counts.get(key) ?? new Map<string, number>()).entries()]
              .map(([value, count]) => ({ value, count }))
              .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));

            return { key, label, values, total: values.reduce((sum, value) => sum + value.count, 0) };
          })
          .filter((facet) => facet.values.length > 0 || facetFilters.has(facet.key))
          // "Run" only matters once a previous run was read.
          .filter((facet) => facet.key !== "run" || facet.values.length > 1 || facetFilters.has("run"));
      });

      /** The lines over the read window, in even buckets stacked by level. */
      const histogram = computed((): readonly HistogramBucket[] => {
        const end = Math.max(now.get(), loadedAt.get() ?? 0);
        const start = end - windowSeconds.get() * 1000;
        const width = (end - start) / histogramBuckets;
        const buckets = Array.from({ length: histogramBuckets }, (_, index) => ({
          start: start + index * width,
          end: start + (index + 1) * width,
          counts: { error: 0, warn: 0, info: 0, debug: 0 } as Record<LogLevel, number>,
          total: 0,
        }));

        for (const line of facetFiltered.get()) {
          const index = Math.floor((line.timestamp - start) / width);
          const bucket = buckets[Math.min(Math.max(index, 0), histogramBuckets - 1)];

          if (line.timestamp >= start - width) {
            bucket.counts[line.level]++;
            bucket.total++;
          }
        }

        return buckets;
      });

      /**
       * Since when the lines drawn are complete: before it, at least one of their containers had
       * more lines than were read. Undefined when everything in the window was read.
       */
      const completeFrom = computed(() => {
        const start = Math.max(now.get(), loadedAt.get() ?? 0) - windowSeconds.get() * 1000;
        const shown = new Set(facetFiltered.get().map(containerKeyOf));
        let latest: number | undefined;

        for (const result of reads.values()) {
          for (const [key, oldest] of result.cutAt ?? []) {
            if ((key === everyContainer || shown.has(key)) && oldest > start && (latest === undefined || oldest > latest)) {
              latest = oldest;
            }
          }
        }

        return latest;
      });

      /** The lines on screen grouped by what they say once the varying parts are taken out. */
      const patterns = computed((): readonly Pattern[] => {
        const lines = filtered.get();
        const first = lines[0]?.timestamp ?? 0;
        const last = lines.at(-1)?.timestamp ?? first;
        const width = Math.max(1, (last - first) / patternBuckets);
        const groups = new Map<string, { lines: LogLine[]; pods: Set<string>; levels: Record<LogLevel, number>; series: number[] }>();

        for (const line of lines) {
          const shape = patternOf(line);
          const group = groups.get(shape) ?? {
            lines: [],
            pods: new Set<string>(),
            levels: { error: 0, warn: 0, info: 0, debug: 0 },
            series: Array.from({ length: patternBuckets }, () => 0),
          };

          group.lines.push(line);
          group.pods.add(`${line.clusterId}|${line.namespace}|${line.pod}`);
          group.levels[line.level]++;
          group.series[Math.min(patternBuckets - 1, Math.floor((line.timestamp - first) / width))]++;
          groups.set(shape, group);
        }

        return [...groups.entries()]
          .map(([shape, group]): Pattern => {
            const levelOfGroup = (["error", "warn", "info", "debug"] as const).reduce((best, candidate) =>
              group.levels[candidate] > group.levels[best] ? candidate : best,
            );

            return {
              shape,
              count: group.lines.length,
              level: group.levels.error > 0 ? "error" : group.levels.warn > 0 ? "warn" : levelOfGroup,
              sample: group.lines.at(-1)!,
              pods: group.pods.size,
              firstSeen: group.lines[0].timestamp,
              lastSeen: group.lines.at(-1)!.timestamp,
              series: group.series,
            };
          })
          .sort((left, right) => right.count - left.count);
      });

      const selectedLine = computed(() => {
        const id = selectedLineId.get();

        return id === undefined ? undefined : merged.get().find((line) => line.id === id);
      });

      // Filters and view come back as the user left them, and are saved as they change.
      let explorationLoaded = false;

      void getTabExplorationsOnce().then((stored) => {
        const saved = stored.get(tabId);

        runInAction(() => {
          if (saved) {
            level.set(saved.level);
            useRegex.set(saved.useRegex);
            view.set(saved.view);
            // Earlier versions kept the facets apart from the query; they are written into it now.
            let text = saved.query;

            for (const [key, filter] of Object.entries(saved.facets ?? {})) {
              text = setFacetInQuery(text, key as FacetKey, filter, toQuery);
            }

            query.set(text);

            if (saved.liveIntervalSeconds) {
              liveIntervalSeconds.set(saved.liveIntervalSeconds);
            }

            if (saved.windowSeconds !== windowSeconds.get()) {
              windowSeconds.set(saved.windowSeconds);

              if (attachments > 0) {
                void refresh();
              }
            }
          }

          explorationLoaded = true;
        });

        reaction(
          (): Exploration => ({
            level: level.get(),
            windowSeconds: windowSeconds.get(),
            liveIntervalSeconds: liveIntervalSeconds.get(),
            query: query.get(),
            useRegex: useRegex.get(),
            view: view.get(),
            facets: {},
          }),
          (exploration) => {
            if (explorationLoaded) {
              stored.set(tabId, exploration);
            }
          },
          { delay: 300 },
        );
      });

      const allPods = computed(() =>
        clusterIds.get().flatMap((clusterId) => inventories.get(clusterId)?.pods ?? []),
      );

      const namespaceCandidates = computed(() => {
        const wanted = pickerQuery.get().trim().toLowerCase();
        const counts = new Map<string, number>();

        for (const pod of allPods.get()) {
          counts.set(pod.namespace, (counts.get(pod.namespace) ?? 0) + 1);
        }

        // A namespace picked stays in the list, even when it has no pods left.
        for (const namespace of scope.get().namespaces) {
          counts.set(namespace, counts.get(namespace) ?? 0);
        }

        return [...counts.entries()]
          .filter(([namespace]) => !wanted || namespace.toLowerCase().includes(wanted))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([namespace, pods]) => ({ namespace, pods }));
      });

      const sourceCandidates = computed(() => {
        const wanted = pickerQuery.get().trim().toLowerCase();
        const namespaces = scope.get().namespaces;
        const groups = new Map<string, { kind: SourceKind; namespace: string; name: string; clusterIds: Set<string>; pods: number }>();

        const offer = (clusterId: string, kind: SourceKind, namespace: string, name: string) => {
          if (wanted && !`${kind} ${namespace}/${name}`.toLowerCase().includes(wanted)) {
            return;
          }

          const key = sourceGroupKey({ kind, namespace, name });
          const group = groups.get(key) ?? { kind, namespace, name, clusterIds: new Set<string>(), pods: 0 };

          group.clusterIds.add(clusterId);
          group.pods++;
          groups.set(key, group);
        };

        for (const pod of allPods.get()) {
          if (namespaces.length > 0 && !namespaces.includes(pod.namespace)) {
            continue;
          }

          if (pod.owner.kind !== "Pod") {
            offer(pod.clusterId, pod.owner.kind, pod.namespace, pod.owner.name);
          }

          offer(pod.clusterId, "Pod", pod.namespace, pod.name);
        }

        for (const source of scope.get().sources) {
          const key = sourceGroupKey(source);

          if (!groups.has(key) && (!wanted || `${source.kind} ${source.namespace}/${source.name}`.toLowerCase().includes(wanted))) {
            groups.set(key, { kind: source.kind, namespace: source.namespace, name: source.name, clusterIds: new Set([source.clusterId]), pods: 0 });
          }
        }

        const kindOrder: readonly SourceKind[] = ["Deployment", "StatefulSet", "DaemonSet", "Job", "Pod"];

        return [...groups.values()]
          .map((group): SourceCandidate => ({ ...group, clusterIds: [...group.clusterIds] }))
          .sort(
            (left, right) =>
              kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) ||
              `${left.namespace}/${left.name}`.localeCompare(`${right.namespace}/${right.name}`),
          )
          .slice(0, 200);
      });

      const groupedSources = computed(() => {
        const groups = new Map<string, LogSource[]>();

        for (const source of scope.get().sources) {
          const key = sourceGroupKey(source);

          groups.set(key, [...(groups.get(key) ?? []), source]);
        }

        return [...groups.entries()].map(([key, sources]) => ({ key, first: sources[0], sources }));
      });

      const refreshSoon = () => {
        if (attachments > 0) {
          void refresh();
        }
      };

      /**
       * Filters set from anywhere but the search box and the facets (a row, the details, an alarm, a
       * pattern): each facet to only the value given, or cleared when undefined, and a phrase added,
       * all in the query, so the box and the facets always say what is filtered.
       */
      const applyFilters = (facets: readonly (readonly [FacetKey, string | undefined])[], phrase?: string) => {
        let text = query.get();

        for (const [key, value] of facets) {
          text = setFacetInQuery(text, key, { include: value === undefined ? [] : [value], exclude: [] }, toQuery);
        }

        if (phrase && !text.toLowerCase().includes(`"${phrase}"`)) {
          text = `${text} "${phrase}"`.trim();
        }

        useRegex.set(false);
        query.set(text);
        timeRange.set(undefined);
        view.set("timeline");
      };

      /**
       * The top bar narrowed to one resource: its cluster, its namespace and it in Resources, so the
       * dropdowns say what the filter says, and only that is read.
       */
      const readableKinds = new Set<string>(sourceKinds);

      /** The resource a filter narrowed the top bar to: while it lasts, the top bar and the facets let go of it together. */
      const linked = observable.box<{ clusterId: string; namespace: string; kind: SourceKind; name: string } | undefined>(undefined, {
        deep: false,
      });

      const narrowTo = (clusterId: string, namespace: string, kind: SourceKind, name: string) => {
        setScope({ clusterIds: [clusterId], namespaces: [namespace], sources: [{ clusterId, kind, namespace, name }] });
        linked.set({ clusterId, namespace, kind, name });
        refreshSoon();
      };

      const includes = (key: FacetKey, value: string) =>
        (facetFilters.get(key)?.include ?? []).some((candidate) => candidate.toLowerCase() === value.toLowerCase());

      // A facet unticked, or its clause taken out of the box: the top bar lets go of it too.
      reaction(
        () => {
          const target = linked.get();

          return target
            ? {
                resource: target.kind === "Pod" ? includes("pod", target.name) : includes("workload", `${target.kind} ${target.name}`),
                namespace: includes("namespace", target.namespace),
                cluster: includes("cluster", target.clusterId),
              }
            : undefined;
        },
        (held) => {
          const target = linked.get();

          if (!held || !target) {
            return;
          }

          const current = scope.get();
          const next: { -readonly [K in keyof Scope]?: Scope[K] } = {};

          if (!held.resource && current.sources.length > 0) {
            next.sources = [];
          }

          if (!held.namespace && current.namespaces.length > 0) {
            next.namespaces = [];
          }

          if (!held.cluster && current.clusterIds.length > 0) {
            next.clusterIds = [];
            next.sources = [];
          }

          if (Object.keys(next).length > 0) {
            setScope(next);
            refreshSoon();
          }

          if (!held.resource && !held.namespace && !held.cluster) {
            linked.set(undefined);
          }
        },
      );

      // A dropdown set back to All, or to something else: its facets go out of the box too.
      reaction(
        () => scope.get(),
        (current) => {
          const target = linked.get();

          if (!target) {
            return;
          }

          let text = query.get();
          const release = (key: FacetKey) => (text = setFacetInQuery(text, key, { include: [], exclude: [] }, toQuery));
          const resourceKept = current.sources.some(
            (source) => source.clusterId === target.clusterId && source.kind === target.kind && source.namespace === target.namespace && source.name === target.name,
          );

          if (!resourceKept) {
            release("pod");
            release("workload");
            release("container");
          }

          if (!current.namespaces.includes(target.namespace)) {
            release("namespace");
          }

          if (!current.clusterIds.includes(target.clusterId)) {
            release("cluster");
          }

          if (text !== query.get()) {
            query.set(text);
          }

          if (!resourceKept && !current.namespaces.includes(target.namespace) && !current.clusterIds.includes(target.clusterId)) {
            linked.set(undefined);
          }
        },
      );

      /** A line's cluster, namespace, workload and pod, as facets to tick. */
      const facetsOfLine = (line: LogLine): (readonly [FacetKey, string | undefined])[] => [
        ["cluster", line.clusterId],
        ["namespace", line.namespace],
        ["workload", workloadOf(line)],
        ["pod", line.pod],
      ];

      const session = {
        tabId,
        isReady: computed(() => persisted.get() !== undefined),
        scope,
        clusterIds,
        isNarrowed,
        query,
        useRegex,
        caseSensitive,
        newestFirst,
        showFacets,
        levelCounts,
        level,
        windowSeconds,
        live,
        liveIntervalSeconds,
        view,
        loadedAt,
        now,
        reading,
        picker,
        pickerQuery,
        namespaceCandidates,
        sourceCandidates,
        groupedSources,
        merged,
        filtered,
        facetFiltered,
        alarms,
        facets,
        facetFilters,
        previousNotice,
        dismissPreviousNotice: action(() => previousNotice.set(undefined)),
        histogram,
        completeFrom,
        patterns,
        timeRange,
        selectedLine,
        contextOfSelected: computed(() => {
          const line = selectedLine.get();

          return line ? contextOf(merged.get(), line, 20) : [];
        }),
        facetValueOf,
        matcherIsInvalid: computed(() => matcher.get() === null),
        queryProblems: computed(() => parsed.get().problems),
        fieldKeys,
        toQuery,
        matcher,
        podOf: (clusterId: string, namespace: string, pod: string) => ownerOfPod.get().get(`${clusterId}|${namespace}|${pod}`),
        resourceOfLine,

        isLoading: computed(() => reading.get() || [...reads.values()].some((result) => result.loading)),
        inventoryErrors: computed(() =>
          clusterIds.get().flatMap((clusterId) => {
            const error = inventories.get(clusterId)?.error;

            return error ? [{ clusterId, error }] : [];
          }),
        ),
        coverage: computed(() =>
          clusterIds.get().flatMap((clusterId) => {
            const covered = coverage.get(clusterId);

            return covered && covered.podsRead < covered.podsTotal ? [{ clusterId, ...covered }] : [];
          }),
        ),
        unreadable: computed(() => [...reads.values()].reduce((sum, result) => sum + result.unreadable, 0)),
        problems: computed(() =>
          [...reads.entries()].flatMap(([key, result]) => result.problems.map((problem) => ({ key, clusterId: key.split("|")[0], problem }))),
        ),
        counts: computed(() => {
          const lines = filtered.get();

          return {
            lines: lines.length,
            clusters: new Set(lines.map((line) => line.clusterId)).size,
            pods: new Set(lines.map((line) => `${line.clusterId}|${line.namespace}|${line.pod}`)).size,
            errors: lines.filter((line) => line.level === "error").length,
            warnings: lines.filter((line) => line.level === "warn").length,
          };
        }),

        /** Called by the tab while it is on screen; the returned function ends the attachment. */
        attach: () => {
          attachments++;

          if (attachments === 1) {
            void refresh();
            clockTimer = setInterval(() => runInAction(() => now.set(Date.now())), 5000);

            if (live.get()) {
              startLive();
            }
          }

          return () => {
            attachments--;

            if (attachments === 0) {
              stopLive();
              clearInterval(clockTimer);
              generation++;
              runInAction(() => reading.set(false));
            }
          };
        },

        /** Reads again now: only what is new since the last read, everything for what was not read yet. */
        refresh: () => void refresh(),

        toggleLive: action(() => {
          live.set(!live.get());

          if (live.get() && attachments > 0) {
            startLive();
            void refresh();
          } else {
            stopLive();
          }
        }),

        /** How often Live reads again; a running Live picks it up at once. */
        setLiveInterval: action((seconds: number) => {
          liveIntervalSeconds.set(seconds);

          if (live.get() && attachments > 0) {
            stopLive();
            startLive();
          }
        }),

        setWindow: action((seconds: number) => {
          windowSeconds.set(seconds);
          refreshSoon();
        }),

        setView: action((next: View) => view.set(next)),

        addCluster: action((clusterId: string) => {
          const current = scope.get().clusterIds;

          if (current.includes(clusterId) || current.length >= limits.maxClusters) {
            return;
          }

          setScope({ clusterIds: [...current, clusterId] });
          refreshSoon();
        }),

        removeCluster: action((clusterId: string) => {
          setScope({
            clusterIds: scope.get().clusterIds.filter((id) => id !== clusterId),
            sources: scope.get().sources.filter((source) => source.clusterId !== clusterId),
          });
          refreshSoon();
        }),

        addNamespace: action((namespace: string) => {
          setScope({ namespaces: [...scope.get().namespaces, namespace] });
          refreshSoon();
        }),

        removeNamespace: action((namespace: string) => {
          setScope({
            namespaces: scope.get().namespaces.filter((candidate) => candidate !== namespace),
            sources: scope.get().sources.filter((source) => source.namespace !== namespace),
          });
          refreshSoon();
        }),

        addSource: action((candidate: SourceCandidate) => {
          const added = candidate.clusterIds.map((clusterId): LogSource => ({
            clusterId,
            kind: candidate.kind,
            namespace: candidate.namespace,
            name: candidate.name,
          }));

          setScope({ sources: [...scope.get().sources, ...added] });
          refreshSoon();
        }),

        removeSourceGroup: action((groupKey: string) => {
          setScope({ sources: scope.get().sources.filter((source) => sourceGroupKey(source) !== groupKey) });
          refreshSoon();
        }),

        resetClusters: action(() => {
          setScope({ clusterIds: [], sources: [] });
          refreshSoon();
        }),

        resetNamespaces: action(() => {
          setScope({ namespaces: [], sources: [] });
          refreshSoon();
        }),

        resetSources: action(() => {
          setScope({ sources: [] });
          refreshSoon();
        }),

        resetScope: action(() => {
          setScope({ namespaces: [], sources: [] });
          refreshSoon();
        }),

        /** Only this pod: the top bar narrowed to it, and its cluster, namespace, workload and pod ticked in the facets. */
        onlyPod: action((line: LogLine) => {
          narrowTo(line.clusterId, line.namespace, "Pod", line.pod);
          applyFilters([...facetsOfLine(line), ["container", undefined]]);
        }),

        /** Only this container of its pod: as Only this pod, with the container ticked too. */
        onlyContainer: action((line: LogLine) => {
          narrowTo(line.clusterId, line.namespace, "Pod", line.pod);
          applyFilters([...facetsOfLine(line), ["container", line.container]]);
        }),

        /** Hide this pod: a `-pod:` clause, the Pod facet showing it left out. */
        hidePod: action((line: LogLine) => {
          useRegex.set(false);
          const current = facetFilters.get("pod") ?? { include: [], exclude: [] };

          if (!current.exclude.includes(line.pod)) {
            query.set(
              setFacetInQuery(query.get(), "pod", { include: current.include.filter((value) => value !== line.pod), exclude: [...current.exclude, line.pod] }, toQuery),
            );
          }
        }),

        /** An alarm's lines: its resource and level in the facets, and the words of its message as a phrase. */
        showAlarmInTimeline: action((alarm: Alarm) => {
          const isPod = alarm.resource.kind === "Pod";

          level.set("all");
          // A kind the Resources picker cannot read (a node, a service…) leaves the top bar as it is.
          if (readableKinds.has(alarm.resource.kind)) {
            narrowTo(alarm.clusterId, alarm.resource.namespace, alarm.resource.kind as SourceKind, alarm.resource.name);
          }

          applyFilters(
            [
              ["cluster", alarm.clusterId],
              ["namespace", alarm.resource.namespace],
              ["workload", isPod ? undefined : `${alarm.resource.kind} ${alarm.resource.name}`],
              ["pod", isPod ? alarm.resource.name : undefined],
              ["level", alarm.level],
            ],
            phraseOf(alarm.message),
          );
        }),

        clearFilters: action(() => {
          query.set("");
          level.set("all");
          timeRange.set(undefined);
        }),

        /** Clicking a value adds it to (or takes it out of) what the facet keeps or leaves out, in the query. */
        toggleFacet: action((key: FacetKey, value: string, mode: "include" | "exclude" = "include") => {
          const current = facetFilters.get(key) ?? { include: [], exclude: [] };
          const other = mode === "include" ? "exclude" : "include";
          const list = current[mode];
          const next = {
            [mode]: list.includes(value) ? list.filter((candidate) => candidate !== value) : [...list, value],
            [other]: current[other].filter((candidate) => candidate !== value),
          } as unknown as FacetFilter;

          useRegex.set(false);
          query.set(setFacetInQuery(query.get(), key, next, toQuery));
        }),

        onlyFacet: action((key: FacetKey, value: string) => {
          useRegex.set(false);
          query.set(setFacetInQuery(query.get(), key, { include: [value], exclude: [] }, toQuery));
        }),

        clearFacet: action((key: FacetKey) => query.set(setFacetInQuery(query.get(), key, { include: [], exclude: [] }, toQuery))),

        /** Reads a container's run before its last restart, and shows only that container. */
        showPreviousRun: async (clusterId: string, namespace: string, podName: string, container: string) => {
          const pod = ownerOfPod.get().get(`${clusterId}|${namespace}|${podName}`);
          const status = pod?.containers.find((candidate) => candidate.name === container);
          if (!pod || !status || status.restarts === 0) {
            runInAction(() => previousNotice.set(`${podName}/${container} has not restarted: there is no previous run to read.`));

            return;
          }

          const key = previousKeyOf(clusterId, pod, container, status.restarts);

          runInAction(() => {
            askedPrevious.add(key);
            plannedReads.set(new Set([...plannedReads.get(), key]));
            previousNotice.set(undefined);
            applyFilters([
              ["pod", podName],
              ["container", container],
              ["run", "previous"],
            ]);
          });

          const read = await readPrevious(-1, key, clusterId, pod, container);

          if (read === 0) {
            runInAction(() => previousNotice.set(`Kubernetes no longer has the previous run of ${podName}/${container}.`));
          }
        },

        containerOf: (line: LogLine) => ownerOfPod.get().get(`${line.clusterId}|${line.namespace}|${line.pod}`)?.containers.find((container) => container.name === line.container),

        setTimeRange: action((range: TimeRange | undefined) => timeRange.set(range)),

        /** A pattern's lines: its level in the facets and the words of its message as a phrase. */
        filterPattern: action((pattern: Pattern) => {
          level.set("all");
          applyFilters([["level", pattern.level]], phraseOf(firstLineOf(messageOf(pattern.sample))));
        }),

        select: action((id: string | undefined) => selectedLineId.set(id)),

        openPicker: action((which: Picker) => {
          picker.set(which);
          pickerQuery.set("");
        }),

        closePicker: action(() => picker.set(undefined)),
      };

      return session;
    };
  },
});

export type Session = ReturnType<ReturnType<(typeof sessionInjectable)["instantiate"]>>;
