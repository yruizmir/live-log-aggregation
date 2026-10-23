import { askAiInjectionToken } from "@k8slens/ask-ai-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { clustersInjectable } from "./clusters.injectable";
import { goToInjectable } from "./go-to.injectable";
import { type Alarm, type LogLine, timeWindows } from "./model";
import type { Session } from "./session.injectable";

const maxContextLines = 200;
const linesAroundError = 10;
const linesAroundPickedLine = 30;

/**
 * Hands what is on screen to Ask AI: the scope, the filters, and the lines that matter, so the
 * assistant starts from what the user is looking at and drills into the cluster from there.
 */
export const askAiAboutLogsInjectable = getInjectable2({
  id: "logs-aggregator-ask-ai-about-logs",
  consumptions: [askAiInjectionToken],

  instantiate: (di) => {
    const startAskAi = di.inject(askAiInjectionToken)();
    const goTo = di.inject(goToInjectable)();
    const clusterContexts = di.inject(clustersInjectable)();

    /**
     * Ask AI opens in the dock of the cluster it is about, which a main-view tab does not show, so
     * the user is taken into that cluster first. To its pods, not to a resource: a details panel
     * would cover the dock, and the conversation with it.
     */
    const askAi = async (options: Parameters<typeof startAskAi>[0], namespace?: string) => {
      if (await goTo.cluster(options.clusterId, namespace)) {
        await startAskAi(options);
      }
    };

    const format = (line: LogLine) =>
      `${line.time} [${clusterContexts.nameOf(line.clusterId)}] ${line.namespace}/${line.pod}/${line.container}: ${line.message}`;

    const describeScope = (session: Session) => {
      const scope = session.scope.get();
      const window = timeWindows.find((candidate) => candidate.seconds === session.windowSeconds.get());

      return [
        "The user is looking at Live Log Aggregation, which merges the logs of pods, workloads and clusters, and their Warning events, into one timeline. Nothing is installed in the clusters; logs were read with kubectl.",
        "",
        "Clusters:",
        ...session.clusterIds
          .get()
          .map((clusterId) => `- ${clusterContexts.nameOf(clusterId)}`),
        `Namespaces: ${scope.namespaces.length > 0 ? scope.namespaces.join(", ") : "all"}`,
        `Resources: ${scope.sources.length > 0 ? scope.sources.map((source) => `${source.kind} ${source.namespace}/${source.name}`).join(", ") : "all"}`,
        `Time window: last ${window?.label ?? `${session.windowSeconds.get()}s`}. Level filter: ${session.level.get()}.${session.query.get() ? ` Search: "${session.query.get()}".` : ""}`,
        "Timestamps come from each node's clock, so ordering across clusters can be off by their clock skew.",
      ].join("\n");
    };

    /** The cluster with the most errors on screen, since a conversation is about one cluster. */
    const busiestCluster = (lines: readonly LogLine[], session: Session) => {
      const errorsByCluster = new Map<string, number>();

      for (const line of lines) {
        if (line.level === "error") {
          errorsByCluster.set(line.clusterId, (errorsByCluster.get(line.clusterId) ?? 0) + 1);
        }
      }

      const [busiest] = [...errorsByCluster.entries()].sort((left, right) => right[1] - left[1]);

      return busiest?.[0] ?? lines.at(-1)?.clusterId ?? session.clusterIds.get()[0];
    };

    const around = (all: readonly LogLine[], index: number, radius: number) =>
      all.slice(Math.max(0, index - radius), index + radius + 1);

    const describePod = (session: Session, clusterId: string, namespace: string, pod?: string) => {
      const info = pod ? session.podOf(clusterId, namespace, pod) : undefined;

      return info
        ? `Pod ${namespace}/${info.name}: phase ${info.phase || "unknown"}, ${info.ready ? "ready" : "not ready"}, ${info.restarts} restarts, owned by ${info.owner.kind} ${info.owner.name}.`
        : "";
    };

    return () => ({
      aboutView: async (session: Session) => {
        const all = session.merged.get();
        const visible = session.filtered.get();
        const clusterId = busiestCluster(visible, session);

        if (!clusterId) {
          return;
        }

        const errors = visible.filter((line) => line.level === "error");
        const picked = new Set<LogLine>();

        if (errors.length > 0) {
          for (const error of errors.slice(-20)) {
            for (const line of around(all, all.indexOf(error), linesAroundError)) {
              picked.add(line);
            }

            if (picked.size >= maxContextLines) {
              break;
            }
          }
        } else {
          for (const line of visible.slice(-150)) {
            picked.add(line);
          }
        }

        const excerpt = all.filter((line) => picked.has(line)).slice(-maxContextLines);
        const alarms = session.alarms.get().slice(0, 15);

        await askAi(
          {
            clusterId,
            prompt:
              errors.length > 0
                ? "Find the root cause of the errors in these logs, and tell me what to check next in the cluster."
                : "Summarise what these logs show and point out anything unusual.",
            context: [
              describeScope(session),
              "",
              ...(alarms.length > 0
                ? [
                    "Alarms on screen, grouped by resource:",
                    ...alarms.map(
                      (alarm) =>
                        `- [${clusterContexts.nameOf(alarm.clusterId)}] ${alarm.resource.kind} ${alarm.resource.namespace}/${alarm.resource.name}: ${alarm.message.slice(0, 200)} (×${alarm.count})`,
                    ),
                    "",
                  ]
                : []),
              errors.length > 0
                ? `${errors.length} error lines are on screen; these are the latest of them with the lines around each:`
                : "The latest lines on screen:",
              "```",
              ...excerpt.map(format),
              "```",
            ].join("\n"),
          },
          (errors.at(-1) ?? visible.at(-1))?.namespace,
        );
      },

      aboutLine: async (session: Session, line: LogLine) => {
        const all = session.merged.get();

        await askAi(
          {
            clusterId: line.clusterId,
            prompt: `Explain this ${line.event ? "event" : "log line"} from ${line.namespace}/${line.pod}${line.event ? "" : ` (container ${line.container})`} and investigate its cause: ${line.message.slice(0, 300)}`,
            context: [
              describeScope(session),
              describePod(session, line.clusterId, line.namespace, line.pod),
              "",
              "The line, with the merged lines around it:",
              "```",
              ...around(all, all.indexOf(line), linesAroundPickedLine).map((candidate) =>
                candidate === line ? `>>> ${format(candidate)}` : format(candidate),
              ),
              "```",
            ].join("\n"),
          },
          line.namespace,
        );
      },

      aboutAlarm: async (session: Session, alarm: Alarm) => {
        const all = session.merged.get();
        const latest = alarm.lines.at(-1);
        const nearby = latest
          ? around(
              all.filter((line) => line.clusterId === alarm.clusterId && line.namespace === alarm.resource.namespace),
              all.filter((line) => line.clusterId === alarm.clusterId && line.namespace === alarm.resource.namespace).indexOf(latest),
              linesAroundError,
            )
          : [];

        await askAi(
          {
            clusterId: alarm.clusterId,
            prompt: `Investigate this alarm on ${alarm.resource.kind} ${alarm.resource.namespace}/${alarm.resource.name}: find the root cause and tell me how to fix it.`,
            context: [
              describeScope(session),
              "",
              `Alarm (${alarm.origin === "event" ? `Warning event ${alarm.reason}` : "error in the logs"}), seen ${alarm.count} times between ${new Date(alarm.firstSeen).toISOString()} and ${new Date(alarm.lastSeen).toISOString()}:`,
              alarm.message,
              alarm.event ? `Event ${alarm.event.namespace}/${alarm.event.name} about ${alarm.event.involvedKind} ${alarm.event.involvedName}.` : "",
              describePod(session, alarm.clusterId, alarm.resource.namespace, alarm.pod),
              "",
              "Its latest occurrences:",
              "```",
              ...alarm.lines.slice(-20).map(format),
              "```",
              ...(nearby.length > 0 ? ["", "Lines around the latest one in the same namespace:", "```", ...nearby.map(format), "```"] : []),
            ]
              .filter((part) => part !== undefined)
              .join("\n"),
          },
          alarm.resource.namespace,
        );
      },
    });
  },
});
