export type SourceKind = "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "Pod";

export const sourceKinds: readonly SourceKind[] = ["Deployment", "StatefulSet", "DaemonSet", "Job", "Pod"];

/** A workload or a pod of one cluster that the user narrowed the tab to. */
export interface LogSource {
  readonly clusterId: string;
  readonly kind: SourceKind;
  readonly namespace: string;
  readonly name: string;
  /** Kept from earlier versions, which read a workload by its label selector. */
  readonly selector?: string;
}

/**
 * What a tab reads. Every list left empty means "all": all connected clusters, all their
 * namespaces, every pod in them. What the user picks only narrows that down.
 */
export interface Scope {
  readonly clusterIds: readonly string[];
  readonly namespaces?: readonly string[];
  readonly sources: readonly LogSource[];
}

export const emptyScope: Scope = { clusterIds: [], namespaces: [], sources: [] };

export type LogLevel = "error" | "warn" | "info" | "debug";

export const logLevels: readonly LogLevel[] = ["error", "warn", "info", "debug"];

/** What a Warning event is about, and how to find the event itself again. */
export interface EventRef {
  readonly name: string;
  readonly namespace: string;
  readonly reason: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly involvedKind: string;
  readonly involvedName: string;
}

export interface LogLine {
  readonly id: string;
  readonly clusterId: string;
  readonly namespace: string;
  /** The pod the line came from; for an event, the object the event is about. */
  readonly pod: string;
  /** The container the line came from; `event` for a Kubernetes event. */
  readonly container: string;
  readonly time: string;
  readonly timestamp: number;
  readonly message: string;
  readonly level: LogLevel;
  readonly event?: EventRef;
  /** What a JSON or logfmt line says, key by key; absent for free text. */
  readonly fields?: Readonly<Record<string, string>>;
  /** How many lines of a stack trace or other multi-line message were joined to this one. */
  readonly continuation?: number;
  /** Read with --previous: the run of the container before its last restart. */
  readonly previous?: boolean;
}

/** A pod as the inventory knows it: where it sits, what owns it, and whether it is healthy. */
export interface PodInfo {
  readonly clusterId: string;
  readonly namespace: string;
  readonly name: string;
  readonly owner: { readonly kind: SourceKind; readonly name: string };
  readonly phase: string;
  readonly restarts: number;
  readonly ready: boolean;
  readonly containers: readonly ContainerStatus[];
}

export interface ContainerStatus {
  readonly name: string;
  readonly restarts: number;
  /** Why its last run ended, such as OOMKilled or Error. */
  readonly lastReason?: string;
  /** Why it is not running now, such as CrashLoopBackOff. */
  readonly waitingReason?: string;
}

/** A resource Lens can show the details of. */
export interface ResourceRef {
  readonly clusterId: string;
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
}

/** Errors and Warning events that say the same thing about the same resource, grouped. */
export interface Alarm {
  readonly id: string;
  readonly origin: "log" | "event";
  readonly level: LogLevel;
  readonly clusterId: string;
  readonly resource: ResourceRef;
  readonly pod?: string;
  readonly message: string;
  readonly reason?: string;
  readonly count: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly event?: EventRef;
  readonly lines: readonly LogLine[];
}

export const sourceKey = (source: Pick<LogSource, "clusterId" | "kind" | "namespace" | "name">) =>
  `${source.clusterId}|${source.kind}|${source.namespace}|${source.name}`;

/** The same workload across clusters: what the source chips and the picker group by. */
export const sourceGroupKey = (source: Pick<LogSource, "kind" | "namespace" | "name">) =>
  `${source.kind}|${source.namespace}|${source.name}`;

const ignoredFields = new Set(["time", "ts", "timestamp", "@timestamp"]);
const logfmtPair = /([A-Za-z_][\w.\-/]*)=("(?:[^"\\]|\\.)*"|\S*)/g;

/** The key/value pairs of a JSON or logfmt line, nested JSON flattened one level (`a.b`). */
export const parseFields = (message: string): Readonly<Record<string, string>> | undefined => {
  const text = message.trim();
  const fields: Record<string, string> = {};

  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text) as unknown;

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            for (const [inner, innerValue] of Object.entries(value)) {
              fields[`${key}.${inner}`] = typeof innerValue === "string" ? innerValue : JSON.stringify(innerValue);
            }
          } else if (!ignoredFields.has(key)) {
            fields[key] = typeof value === "string" ? value : JSON.stringify(value);
          }
        }

        return Object.keys(fields).length > 0 ? fields : undefined;
      }
    } catch {
      // Not JSON after all: try logfmt below.
    }
  }

  let pairs = 0;

  for (const [, key, raw] of text.matchAll(logfmtPair)) {
    pairs++;

    if (!ignoredFields.has(key)) {
      fields[key] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"') : raw;
    }
  }

  return pairs >= 2 ? fields : undefined;
};

/** The text a structured line is about, for the list and for patterns. */
export const messageOf = (line: Pick<LogLine, "message" | "fields">) =>
  line.fields?.msg ?? line.fields?.message ?? line.message;

const levelFromField: Record<string, LogLevel> = {
  error: "error", err: "error", fatal: "error", panic: "error", critical: "error", crit: "error", dpanic: "error",
  warn: "warn", warning: "warn",
  info: "info", notice: "info",
  debug: "debug", trace: "debug", verbose: "debug",
};

const errorPattern =
  /^[EF]\d{4} |\b(error|err|fatal|panic|exception|failed|failure|crit(ical)?|traceback)\b|level["=: ]+(error|fatal|crit)/i;
const warnPattern = /^W\d{4} |\b(warn|warning)\b|level["=: ]+warn/i;

// Only explicit markers: "trace" in prose ("stack trace") is not a level.
const debugPattern = /^D\d{4} |^\[?(DEBUG|TRACE)\]?\b|\b(level|lvl)["=: ]+(debug|trace)\b/;

/** A structured line's own `level` wins; free text is read by the words it uses. */
export const levelOf = (message: string, fields?: Readonly<Record<string, string>>): LogLevel => {
  const stated = fields?.level ?? fields?.lvl ?? fields?.severity ?? fields?.["log.level"];
  const fromField = stated ? levelFromField[stated.toLowerCase()] : undefined;

  if (fromField) {
    return fromField;
  }

  return errorPattern.test(message) ? "error" : warnPattern.test(message) ? "warn" : debugPattern.test(message) ? "debug" : "info";
};

/** The facets of the side panel: what a line is narrowed by besides the text search. */
export type FacetKey = "level" | "cluster" | "namespace" | "workload" | "pod" | "container" | "run" | `field:${string}`;

/**
 * Whether a line carries on the message of the line before it: the frames of a Java, Python or
 * Go stack trace, "Caused by:", the closing of a JSON document printed over several lines.
 */
export const isContinuation = (message: string, previous: string) => {
  const lastOfPrevious = previous.slice(previous.lastIndexOf("\n") + 1);
  const inTrace = previous.includes("\n") || /^(panic:|Traceback|goroutine )/.test(previous);

  if (message.trim() === "") {
    return inTrace;
  }

  return (
    /^\s+\S/.test(message) ||
    /^(Caused by:|Suppressed:|\.\.\. \d+ (more|common frames omitted))/.test(message) ||
    /^[\]})]+[,;]?$/.test(message.trim()) ||
    /^(goroutine \d+ \[|created by )/.test(message) ||
    (inTrace && /^[\w./-]+\.[\w]+\(.*\)$/.test(message)) ||
    (/^[\w.$]+(Exception|Error|Exit)\b/.test(message) && /^\s/.test(lastOfPrevious)) ||
    (/^Traceback \(most recent call last\):/.test(message) && /:$/.test(lastOfPrevious))
  );
};

/** The first line of a message, which is what identifies it and what the list shows. */
export const firstLineOf = (message: string) => {
  const end = message.indexOf("\n");

  return end === -1 ? message : message.slice(0, end);
};

export interface FacetFilter {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** The lines of the same container right before and after a line. */
export const contextOf = (all: readonly LogLine[], line: LogLine, radius: number) => {
  const same = all.filter(
    (candidate) =>
      candidate.clusterId === line.clusterId &&
      candidate.namespace === line.namespace &&
      candidate.pod === line.pod &&
      candidate.container === line.container,
  );
  const index = same.indexOf(line);

  return index < 0 ? [line] : same.slice(Math.max(0, index - radius), index + radius + 1);
};

/** A message with what changes from one occurrence to the next replaced by placeholders, case kept. */
export const maskMessage = (message: string) =>
  message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b\d{4}-\d{2}-\d{2}[t ][\d:.]+z?\b/gi, "<time>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 200);

/**
 * The words of a message that do not change from one occurrence to the next, as a phrase the
 * search box can look for: the longest stretch between the parts that vary (numbers, ids, times)
 * and quotes, of two words or more. Undefined when the message has no such stretch.
 */
export const phraseOf = (message: string) => {
  const pieces = maskMessage(message)
    .split(/#|<id>|<time>|"/)
    .map((piece) => piece.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").trim().toLowerCase())
    .filter((piece) => piece.length >= 8 && piece.split(/\s+/).length >= 2);

  // Words read better than key=value pairs and paths: those only when nothing else is left.
  const words = pieces.filter((piece) => !/[=:{}[\]/\\]/.test(piece));

  return (words.length > 0 ? words : pieces).sort((left, right) => right.length - left.length)[0];
};

/** The same message with what changes from one occurrence to the next taken out. */
export const messageShape = (message: string) => maskMessage(message).toLowerCase();

export const timeWindows = [
  { seconds: 300, label: "5m" },
  { seconds: 900, label: "15m" },
  { seconds: 3600, label: "1h" },
  { seconds: 21_600, label: "6h" },
  { seconds: 86_400, label: "24h" },
] as const;

/** How often Live reads again. */
export const liveIntervals = [
  { seconds: 10, label: "10s" },
  { seconds: 30, label: "30s" },
  { seconds: 60, label: "1m" },
  { seconds: 300, label: "5m" },
] as const;

export const limits = {
  maxClusters: 5,
  /** Lines per container when reading everything, and when narrowed down. */
  tailLinesWhenAll: 50,
  tailLinesWhenNarrowed: 200,
  /** The same over windows longer than an hour, which have more to show. */
  tailLinesWhenAllLong: 200,
  tailLinesWhenNarrowedLong: 1000,
  /** Narrowed to a workload or a pod over 6h or 24h: enough for a day of most containers. */
  tailLinesWhenResourceLong: 30_000,
  /** Containers per cluster whose run before the last restart is read on its own. */
  maxPreviousReadsPerCluster: 5,
  tailLinesPrevious: 200,
  /** How long Kubernetes keeps events by default. */
  eventRetentionSeconds: 3600,
  maxLogRequests: 5,
  /** Pods read per cluster when reading everything; pods in trouble go first. */
  maxPodsPerCluster: 300,
  concurrentReadsPerCluster: 3,
  maxLinesKept: 100_000,
  maxRenderedLines: 2000,
  liveIntervalMs: 10_000,
} as const;
