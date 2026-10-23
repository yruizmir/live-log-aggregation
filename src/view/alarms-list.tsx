import { Div, Span } from "@k8slens/element-components";
import { ErrorIcon, OpenInBrowserIcon, ScheduleIcon, SubjectIcon, WarningIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { askAiAboutLogsInjectable } from "../ask-ai-about-logs.injectable";
import { clustersInjectable } from "../clusters.injectable";
import { goToInjectable } from "../go-to.injectable";
import type { Alarm } from "../model";
import type { Session } from "../session.injectable";
import { AskAiIcon } from "./ask-ai-icon";
import { ClusterDot } from "./cluster-dot";

const ago = (timestamp: number, now: number) => {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));

  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;
};

/** Every error and Warning event on screen, grouped, each with something to do about it. */
export const AlarmsList = observer(({ session }: { readonly session: Session }) => {
  const alarms = session.alarms.get();

  if (alarms.length === 0) {
    return (
      <Div $flex={{ direction: "vertical", gap: "m", horizontalAlign: "center", verticalAlign: "center" }} $flexChild $padding="xl">
        <Span $font={{ size: "l" }}>{session.isLoading.get() ? "Reading logs and events…" : "No alarms in this time window"}</Span>
        <Span $color="textMuted">Errors in the logs and Warning events from Kubernetes show up here, grouped by resource.</Span>
      </Div>
    );
  }

  return (
    <Div $flexChild $className="la-alarms">
      {alarms.map((alarm) => (
        <AlarmRow key={alarm.id} alarm={alarm} session={session} />
      ))}
    </Div>
  );
});

const AlarmRow = observer(({ alarm, session }: { readonly alarm: Alarm; readonly session: Session }) => {
  const clusterContexts = useInject(clustersInjectable)();
  const goTo = useInject(goToInjectable)();
  const askAiAboutLogs = useInject(askAiAboutLogsInjectable)();
  const now = session.now.get();
  const LevelIcon = alarm.level === "error" ? ErrorIcon : WarningIcon;
  const pod = alarm.pod ? session.podOf(alarm.clusterId, alarm.resource.namespace, alarm.pod) : undefined;
  const lineContainer = alarm.lines.at(-1)?.event ? undefined : alarm.lines.at(-1)?.container;
  const restarted = pod?.containers
    .filter((container) => container.restarts > 0)
    .sort((left, right) => (left.name === lineContainer ? -1 : right.name === lineContainer ? 1 : right.restarts - left.restarts))[0];

  return (
    <Div $className={["la-alarm", `la-alarm--${alarm.level}`]} $flex={{ gap: "m", verticalAlign: "top" }}>
      <LevelIcon $size="m" $color={alarm.level === "error" ? "critical" : "warning"} />

      <Div $flexChild $flex={{ direction: "vertical", gap: "xxs" }}>
        <Div $flex={{ gap: "s", verticalAlign: "center", wrap: true }}>
          <Span $font={{ bold: true }}>{alarm.origin === "event" ? alarm.reason : "Error in the logs"}</Span>
          <ClusterDot clusterId={alarm.clusterId} />
          <Span $color="textMuted">
            {clusterContexts.nameOf(alarm.clusterId)} · {alarm.resource.kind} {alarm.resource.namespace}/{alarm.resource.name}
            {alarm.pod && alarm.pod !== alarm.resource.name ? ` · pod ${alarm.pod}` : ""}
          </Span>
        </Div>
        <Span $className="la-alarm-message">{alarm.message}</Span>
        <Span $color="textMuted" $className="la-alarm-meta">
          <ScheduleIcon $size="xs" /> {alarm.count.toLocaleString()}× · last {ago(alarm.lastSeen, now)} · first {ago(alarm.firstSeen, now)}
          {restarted && (
            <>
              {" · "}
              <Span $color={/OOMKilled|Error/.test(restarted.lastReason ?? "") ? "critical" : "textMuted"}>
                {restarted.name} restarted {restarted.restarts}×{restarted.lastReason ? `, last: ${restarted.lastReason}` : ""}
              </Span>
            </>
          )}
        </Span>
      </Div>

      <Div $flex={{ gap: "xs", verticalAlign: "center" }} $className="la-alarm-actions">
        <PlainButton $className="la-btn" Icon={OpenInBrowserIcon} onClick={() => void goTo.resource(alarm.resource)} $tooltip={`Open ${alarm.resource.kind} ${alarm.resource.name} in Lens`}>
          Resource
        </PlainButton>
        {alarm.event && (
          <PlainButton
            $className="la-btn"
            Icon={ScheduleIcon}
            onClick={() => void goTo.event(alarm.clusterId, alarm.event!)}
            $tooltip={`Open the event ${alarm.event.name}`}
          >
            Event
          </PlainButton>
        )}
        <PlainButton $className="la-btn" Icon={SubjectIcon} onClick={() => session.showAlarmInTimeline(alarm)} $tooltip="Show its lines in the timeline">
          Lines
        </PlainButton>
        <PrimaryButton $className={["la-btn", "la-btn--accent"]} Icon={AskAiIcon} onClick={() => void askAiAboutLogs.aboutAlarm(session, alarm)} $tooltip="Investigate the root cause with Ask AI">
          Ask AI
        </PrimaryButton>
      </Div>
    </Div>
  );
});
