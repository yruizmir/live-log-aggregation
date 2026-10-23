import { getInjectable2 } from "@k8slens/injectable";
import { runKubectlInjectionToken } from "@k8slens/kubectl-contracts";
import {
  type ContainerStatus,
  type EventRef,
  isContinuation,
  levelOf,
  limits,
  type LogLevel,
  type LogLine,
  parseFields,
  type PodInfo,
  type SourceKind,
} from "./model";

export interface KubectlResult {
  readonly output: string;
  readonly exitCode: number;
}

/**
 * Runs kubectl against a Lens cluster with the kubectl and credentials Lens keeps for it, so any
 * cluster Lens can open is read, whatever the user's own kubeconfig says. A failure is returned
 * with what kubectl said rather than thrown, the way the readers below expect it.
 */
export const runKubectlInjectable = getInjectable2({
  id: "logs-aggregator-run-kubectl",
  consumptions: [runKubectlInjectionToken],

  instantiate: (di) => {
    const runKubectlFor = di.inject(runKubectlInjectionToken);

    return () =>
      async (clusterId: string, args: readonly string[]): Promise<KubectlResult> => {
        try {
          return { output: await runKubectlFor(clusterId)([...args]), exitCode: 0 };
        } catch (error) {
          return { output: (error as Error).message, exitCode: 1 };
        }
      };
  },
});

const failure = (result: KubectlResult) =>
  result.output.trim().split("\n").slice(-3).join("\n") || `kubectl exited with ${result.exitCode}`;

const ownerKinds: Record<string, SourceKind> = {
  Deployment: "Deployment",
  StatefulSet: "StatefulSet",
  DaemonSet: "DaemonSet",
  Job: "Job",
};

const inventoryTemplate = [
  "{range .items[*]}",
  '{.kind}{"\\t"}{.metadata.namespace}{"\\t"}{.metadata.name}{"\\t"}',
  '{.metadata.ownerReferences[0].kind}{"\\t"}{.metadata.ownerReferences[0].name}{"\\t"}',
  '{.status.phase}{"\\t"}{.status.containerStatuses[*].restartCount}{"\\t"}{.status.containerStatuses[*].ready}{"\\t"}',
  '{range .status.containerStatuses[*]}{.name}|{.restartCount}|{.lastState.terminated.reason}|{.state.waiting.reason},{end}{"\\n"}',
  "{end}",
].join("");

/**
 * Every pod of a cluster with the workload that owns it, in one read: pods and replica sets
 * together, so a pod of a deployment is told apart from a bare one without asking again.
 */
export const readInventoryInjectable = getInjectable2({
  id: "logs-aggregator-read-inventory",

  instantiate: (di) => {
    const runKubectl = di.inject(runKubectlInjectable)();

    return () => async (clusterId: string): Promise<PodInfo[]> => {
      const result = await runKubectl(clusterId, [
        "get",
        "pods,replicasets",
        "--all-namespaces",
        "--request-timeout=30s",
        "-o",
        `jsonpath=${inventoryTemplate}`,
      ]);

      if (result.exitCode !== 0) {
        throw new Error(failure(result));
      }

      const rows = result.output.split("\n").map((line) => line.split("\t"));
      const deploymentOfReplicaSet = new Map<string, string>();

      for (const [kind, namespace, name, ownerKind, ownerName] of rows) {
        if (kind === "ReplicaSet" && ownerKind === "Deployment" && ownerName) {
          deploymentOfReplicaSet.set(`${namespace}/${name}`, ownerName);
        }
      }

      return rows.flatMap(([kind, namespace, name, ownerKind = "", ownerName = "", phase = "", restarts = "", ready = "", statuses = ""]): PodInfo[] => {
        if (kind !== "Pod" || !namespace || !name) {
          return [];
        }

        const deployment = ownerKind === "ReplicaSet" ? deploymentOfReplicaSet.get(`${namespace}/${ownerName}`) : undefined;
        const owner = deployment
          ? { kind: "Deployment" as const, name: deployment }
          : ownerKinds[ownerKind]
            ? { kind: ownerKinds[ownerKind], name: ownerName }
            : { kind: "Pod" as const, name };
        const readiness = ready.split(" ").filter(Boolean);

        return [
          {
            clusterId,
            namespace,
            name,
            owner,
            phase,
            restarts: restarts.split(" ").reduce((sum, count) => sum + (Number(count) || 0), 0),
            ready: readiness.length > 0 && readiness.every((value) => value === "true"),
            containers: statuses
              .split(",")
              .filter(Boolean)
              .map((status): ContainerStatus => {
                const [containerName = "", restartCount = "", lastReason = "", waitingReason = ""] = status.split("|");

                return {
                  name: containerName,
                  restarts: Number(restartCount) || 0,
                  lastReason: lastReason || undefined,
                  waitingReason: waitingReason || undefined,
                };
              }),
          },
        ];
      });
    };
  },
});

const errorReasons = /BackOff|Failed|OOM|Evicted|Unhealthy|Error/i;

export const readWarningEventsInjectable = getInjectable2({
  id: "logs-aggregator-read-warning-events",

  instantiate: (di) => {
    const runKubectl = di.inject(runKubectlInjectable)();

    return () => async (clusterId: string, sinceSeconds: number): Promise<LogLine[]> => {
      const result = await runKubectl(clusterId, [
        "get",
        "events",
        "--all-namespaces",
        "--field-selector",
        "type=Warning",
        "--request-timeout=30s",
        "-o",
        "json",
      ]);

      if (result.exitCode !== 0) {
        throw new Error(failure(result));
      }

      interface RawEvent {
        metadata: { name: string; namespace: string };
        reason?: string;
        message?: string;
        count?: number;
        firstTimestamp?: string;
        lastTimestamp?: string;
        eventTime?: string;
        series?: { lastObservedTime?: string; count?: number };
        involvedObject: { kind?: string; name?: string; namespace?: string };
      }

      const { items } = JSON.parse(result.output) as { items: RawEvent[] };
      const oldest = Date.now() - sinceSeconds * 1000;

      return items.flatMap((item): LogLine[] => {
        const time = item.series?.lastObservedTime ?? item.lastTimestamp ?? item.eventTime ?? item.firstTimestamp;
        const timestamp = time ? Date.parse(time) : NaN;

        if (!time || timestamp < oldest) {
          return [];
        }

        const reason = item.reason ?? "Warning";
        const event: EventRef = {
          name: item.metadata.name,
          namespace: item.metadata.namespace,
          reason,
          count: item.series?.count ?? item.count ?? 1,
          firstSeen: item.firstTimestamp ?? time,
          involvedKind: item.involvedObject.kind ?? "",
          involvedName: item.involvedObject.name ?? "",
        };
        const level: LogLevel = errorReasons.test(reason) ? "error" : "warn";

        return [
          {
            id: `${clusterId}|event|${item.metadata.namespace}|${item.metadata.name}|${time}`,
            clusterId,
            namespace: item.involvedObject.namespace ?? item.metadata.namespace,
            pod: event.involvedName,
            container: "event",
            time,
            timestamp,
            message: `${reason}: ${item.message ?? ""}`.trim(),
            level,
            event,
          },
        ];
      });
    };
  },
});

/** Label selector every pod matches: kubectl reads a whole namespace in one request with it. */
const everyPod = "!logs-aggregator.k8slens.dev/none";

export type LogTarget =
  | { readonly namespace: string; readonly selector?: string }
  | { readonly namespace: string; readonly pod: string }
  /** One container's run before its last restart. */
  | { readonly namespace: string; readonly pod: string; readonly container: string; readonly previous: true };

export interface FetchedLogs {
  readonly lines: LogLine[];
  /** Containers that could not be read, such as ones still starting. Expected, not alarming. */
  readonly unreadable: string[];
  readonly problems: string[];
}

// eslint-disable-next-line no-control-regex
const ansiColour = /\u001b\[[0-9;]*m/g;

const linePattern = /^\[pod\/([^/]+)\/([^\]]+)\] (\S+) ?(.*)$/;

/** Reads the last lines of every container of a namespace, a workload or a pod, bounded by time and by count. */
export const fetchLogsInjectable = getInjectable2({
  id: "logs-aggregator-fetch-logs",

  instantiate: (di) => {
    const runKubectl = di.inject(runKubectlInjectable)();

    return () =>
      async (
        clusterId: string,
        target: LogTarget,
        since: { readonly seconds: number } | { readonly time: string },
        tailLines: number,
      ): Promise<FetchedLogs> => {
        const previous = "previous" in target;
        const result = await runKubectl(clusterId, [
          "logs",
          ...("pod" in target ? [`pod/${target.pod}`] : ["-l", target.selector ?? everyPod]),
          "-n",
          target.namespace,
          ...(previous ? ["-c", target.container, "--previous"] : ["--all-containers"]),
          "--prefix",
          "--timestamps",
          // The run before the restart ended at an unknown time: it is read by count alone.
          ...(previous ? [] : ["seconds" in since ? `--since=${since.seconds}s` : `--since-time=${since.time}`]),
          `--tail=${tailLines}`,
          `--max-log-requests=${limits.maxLogRequests}`,
          "--ignore-errors",
          "--request-timeout=30s",
        ]);

        const lines: LogLine[] = [];
        const unreadable: string[] = [];
        const problems: string[] = [];

        // The last line of each container, so the lines of a stack trace join the one they belong to.
        const lastOf = new Map<string, { line: LogLine; parts: string[] }>();
        const joined: { line: LogLine; parts: string[] }[] = [];

        result.output.split("\n").forEach((raw, index) => {
          const match = linePattern.exec(raw);

          if (!match) {
            const text = raw.trim();

            if (/previous terminated container .* not found/i.test(text)) {
              unreadable.push(text);
            } else if (/waiting to start|is terminated|ContainerCreating|PodInitializing|not found/i.test(text)) {
              unreadable.push(text);
            } else if (text && !/^No resources found/i.test(text)) {
              problems.push(text);
            }

            return;
          }

          const [, pod, container, time, coloured] = match;
          const timestamp = Date.parse(time);

          // kubectl prefixes its own messages too ("[pod/x/y] unable to retrieve container logs for ..."): what
          // carries no timestamp is one of those, not a line of the container.
          if (Number.isNaN(timestamp)) {
            unreadable.push(`${pod}/${container}: ${time} ${coloured}`.trim());

            return;
          }

          // Terminal colours some programs log with are noise once off the terminal.
          const message = coloured.replace(ansiColour, "");
          const key = `${pod}/${container}`;
          const last = lastOf.get(key);

          if (last && Math.abs(timestamp - last.line.timestamp) <= 1000 && isContinuation(message, last.parts.join("\n"))) {
            last.parts.push(message);

            return;
          }

          const entry = {
            line: {
              id: `${clusterId}|${target.namespace}|${pod}|${container}|${time}|${index}${previous ? "|previous" : ""}`,
              clusterId,
              namespace: target.namespace,
              pod,
              container,
              time,
              timestamp,
              message,
              level: "info" as LogLevel,
              ...(previous ? { previous: true } : {}),
            },
            parts: [message],
          };

          lastOf.set(key, entry);
          joined.push(entry);
        });

        for (const { line, parts } of joined) {
          const message = parts.join("\n");
          const fields = parseFields(parts[0]) ?? (parts.length > 1 ? parseFields(message) : undefined);

          lines.push({
            ...line,
            message,
            level: levelOf(message, fields),
            fields,
            ...(parts.length > 1 ? { continuation: parts.length - 1 } : {}),
          });
        }

        if (result.exitCode !== 0 && problems.length === 0 && lines.length === 0 && unreadable.length === 0) {
          problems.push(failure(result));
        }

        return { lines, unreadable, problems: problems.slice(0, 5) };
      };
  },
});

const pluralOf: Record<SourceKind, string> = {
  Deployment: "deployment",
  StatefulSet: "statefulset",
  DaemonSet: "daemonset",
  Job: "job",
  Pod: "pod",
};

/** The label selector a workload finds its pods by, so its logs are read in one request. */
export const resolveSelectorInjectable = getInjectable2({
  id: "logs-aggregator-resolve-selector",

  instantiate: (di) => {
    const runKubectl = di.inject(runKubectlInjectable)();

    return () =>
      async (clusterId: string, kind: SourceKind, namespace: string, name: string): Promise<string> => {
        const result = await runKubectl(clusterId, [
          "get",
          pluralOf[kind],
          name,
          "-n",
          namespace,
          "-o",
          "jsonpath={.spec.selector.matchLabels}",
        ]);

        if (result.exitCode !== 0) {
          throw new Error(failure(result));
        }

        const labels = JSON.parse(result.output.trim() || "{}") as Record<string, string>;
        const selector = Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",");

        if (!selector) {
          throw new Error(`${kind} ${name} has no label selector to find its pods by`);
        }

        return selector;
      };
  },
});
