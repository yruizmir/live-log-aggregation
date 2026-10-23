import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useState } from "react";
import { OpenInBrowserIcon, ScheduleIcon, SpinnerIcon } from "@k8slens/icon";
import { askAiAboutLogsInjectable } from "../ask-ai-about-logs.injectable";
import { goToInjectable } from "../go-to.injectable";
import type { Session } from "../session.injectable";
import { AskAiIcon } from "./ask-ai-icon";
import { ClusterDot } from "./cluster-dot";

const shownWhenOpen = 5;

/** The errors and Warning events of the window, folded into one line until opened; the whole list is a click away. */
export const Insights = observer(({ session }: { readonly session: Session }) => {
  const askAiAboutLogs = useInject(askAiAboutLogsInjectable)();
  const goTo = useInject(goToInjectable)();
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState<string | undefined>(undefined);
  const alarms = session.alarms.get();

  if (alarms.length === 0) {
    return null;
  }

  return (
    <Div $flex={{ direction: "vertical" }} $className={["la-insights", { "la-insights--open": open }]}>
      <Div $flex={{ gap: "m", verticalAlign: "center" }} $className="la-insights-head">
        <ClickableDiv $flexChild $flex={{ gap: "m", verticalAlign: "center" }} $onClick={() => setOpen(!open)}>
          <Span $className={["la-insights-caret", { "la-insights-caret--open": open }]}>▸</Span>
          <Span $className="la-insights-badge">✳ {alarms.length}</Span>
          <Span $className="la-insights-title">Insights</Span>
          <Span $className="la-insights-hint">Anomalies detected in this time range</Span>
        </ClickableDiv>
        <ClickableDiv $className="la-link" $onClick={() => session.setView("alarms")}>
          View all
        </ClickableDiv>
      </Div>
      {open && (
        <Div $flex={{ direction: "vertical" }} $className="la-insights-list">
          {alarms.slice(0, shownWhenOpen).map((alarm) => (
            <Div key={alarm.id} $flex={{ gap: "s", verticalAlign: "center" }} $className={["la-insight", `la-insight--${alarm.level}`]}>
              <Span $className="la-insight-count">{alarm.count.toLocaleString()}×</Span>
              <Span $className="la-insight-reason">{alarm.origin === "event" ? alarm.reason : "Error"}</Span>
              <ClusterDot clusterId={alarm.clusterId} />
              <Span $className="la-insight-resource">
                {alarm.resource.kind} {alarm.resource.namespace}/{alarm.resource.name}
              </Span>
              <Span $flexChild $className="la-insight-message">
                {alarm.message}
              </Span>
              <ClickableDiv
                $flex={{ gap: "xxs", verticalAlign: "center" }}
                $className="la-link"
                $onClick={() => {
                  setOpening(alarm.id);
                  void goTo.resource(alarm.resource).finally(() => setOpening(undefined));
                }}
                $tooltip={`Open ${alarm.resource.kind} ${alarm.resource.namespace}/${alarm.resource.name} in Lens`}
              >
                {opening === alarm.id ? <SpinnerIcon $size="xs" /> : <OpenInBrowserIcon $size="xs" />}
                Open {alarm.resource.kind}
              </ClickableDiv>
              {alarm.event && (
                <ClickableDiv
                  $flex={{ gap: "xxs", verticalAlign: "center" }}
                  $className="la-link"
                  $onClick={() => void goTo.event(alarm.clusterId, alarm.event!)}
                  $tooltip={`Open the event ${alarm.event.name} in Lens`}
                >
                  <ScheduleIcon $size="xs" />
                  Event
                </ClickableDiv>
              )}
              <ClickableDiv $className="la-link" $onClick={() => session.showAlarmInTimeline(alarm)} $tooltip="Show only its lines">
                Lines
              </ClickableDiv>
              <ClickableDiv
                $flex={{ gap: "xxs", verticalAlign: "center" }}
                $className="la-link"
                $onClick={() => void askAiAboutLogs.aboutAlarm(session, alarm)}
                $tooltip="Investigate the root cause with Ask AI"
              >
                <AskAiIcon $size="xs" />
                Ask AI
              </ClickableDiv>
            </Div>
          ))}
          {alarms.length > shownWhenOpen && (
            <ClickableDiv $className={["la-link", "la-insights-more"]} $onClick={() => session.setView("alarms")}>
              {alarms.length - shownWhenOpen} more
            </ClickableDiv>
          )}
        </Div>
      )}
    </Div>
  );
});
