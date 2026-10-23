import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import { AddCircleOutlineIcon, CloseIcon, ContentCopyIcon, OpenInBrowserIcon, RemoveCircleOutlineIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useEffect } from "react";
import { askAiAboutLogsInjectable } from "../ask-ai-about-logs.injectable";
import { clustersInjectable } from "../clusters.injectable";
import { goToInjectable } from "../go-to.injectable";
import type { LogLine } from "../model";
import type { Session } from "../session.injectable";
import { ActionIcon } from "./action-icon";
import { AskAiIcon } from "./ask-ai-icon";
import { ClusterDot } from "./cluster-dot";
import { copyText, formatTime } from "./format";

const prettyMessage = (line: LogLine) => {
  const text = line.message.trim();

  if (text.startsWith("{")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return line.message;
    }
  }

  return line.message;
};

/** The side panel of the line picked in the list: everything about it and the lines around it. */
export const DetailPanel = observer(({ session }: { readonly session: Session }) => {
  const line = session.selectedLine.get();
  const clusterContexts = useInject(clustersInjectable)();
  const goTo = useInject(goToInjectable)();
  const askAiAboutLogs = useInject(askAiAboutLogsInjectable)();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        session.select(undefined);
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  if (!line) {
    return null;
  }

  const resource = session.resourceOfLine(line);
  const fields = Object.entries(line.fields ?? {});
  const context = session.contextOfSelected.get();
  const status = line.event ? undefined : session.containerOf(line);

  return (
    <Div $flex={{ direction: "vertical" }} $className="la-detail">
      <Div $flex={{ gap: "xs", verticalAlign: "center" }} $className="la-detail-head">
        <Span $className={["la-level-badge", `la-level-badge--${line.level}`]}>{line.level}</Span>
        <Span $flexChild $className="la-detail-time">
          {formatTime(line.timestamp, line.time)}
        </Span>
        <ActionIcon $onClick={() => copyText(line.message)} $tooltip="Copy the line">
          <ContentCopyIcon />
        </ActionIcon>
        <ActionIcon $onClick={() => session.select(undefined)} $tooltip="Close (Esc)">
          <CloseIcon />
        </ActionIcon>
      </Div>

      <Div $className="la-detail-body">
        <Div $flex={{ direction: "vertical", gap: "xxs" }} $className="la-detail-section">
          <Attribute name="cluster">
            <ClusterDot clusterId={line.clusterId} /> {clusterContexts.nameOf(line.clusterId)}
          </Attribute>
          <Attribute name="namespace">{line.namespace}</Attribute>
          <Attribute name={resource.kind.toLowerCase()}>{resource.name}</Attribute>
          {line.event ? (
            <Attribute name="event">
              {line.event.reason} · {line.event.involvedKind} {line.pod}
            </Attribute>
          ) : (
            <>
              <Attribute name="pod">{line.pod}</Attribute>
              <Attribute name="container">{line.container}</Attribute>
              {status && status.restarts > 0 && (
                <Attribute name="restarts">
                  {status.restarts}
                  {status.lastReason ? ` · last ended: ${status.lastReason}` : ""}
                  {status.waitingReason ? ` · now ${status.waitingReason}` : ""}
                </Attribute>
              )}
              {line.previous && <Attribute name="run">previous (before the last restart)</Attribute>}
            </>
          )}
        </Div>

        <Span $className="la-detail-label">Message</Span>
        <pre className="la-detail-message">{prettyMessage(line)}</pre>

        {fields.length > 0 && (
          <>
            <Span $className="la-detail-label">Fields</Span>
            <Div $flex={{ direction: "vertical" }} $className="la-kv-table">
              {fields.map(([key, value]) => (
                <Div key={key} $flex={{ gap: "xs", verticalAlign: "top" }} $className="la-kv-row">
                  <Span $className="la-kv-key">{key}</Span>
                  <Span $flexChild $className="la-kv-value">
                    {value}
                  </Span>
                  <Span $className="la-kv-actions">
                    <ActionIcon $onClick={() => session.toggleFacet(`field:${key}`, value)} $tooltip={`Keep only ${key}=${value}`}>
                      <AddCircleOutlineIcon />
                    </ActionIcon>
                    <ActionIcon $onClick={() => session.toggleFacet(`field:${key}`, value, "exclude")} $tooltip={`Leave out ${key}=${value}`}>
                      <RemoveCircleOutlineIcon />
                    </ActionIcon>
                    <ActionIcon $onClick={() => copyText(value)} $tooltip="Copy the value">
                      <ContentCopyIcon />
                    </ActionIcon>
                  </Span>
                </Div>
              ))}
            </Div>
          </>
        )}

        {!line.event && (
          <>
            <Div $flex={{ verticalAlign: "center" }}>
              <Span $flexChild $className="la-detail-label">
                Context · {line.container}
              </Span>
              <PlainButton
                $className="la-btn"
                onClick={() => session.onlyContainer(line)}
                $tooltip="Show only this container in the list"
              >
                Only this container
              </PlainButton>
            </Div>
            <Div $flex={{ direction: "vertical" }} $className="la-context">
              {context.map((candidate) => (
                <ClickableDiv
                  key={candidate.id}
                  $className={["la-context-line", `la-row--${candidate.level}`, { "la-context-line--current": candidate.id === line.id }]}
                  $onClick={() => session.select(candidate.id)}
                >
                  <Span $className="la-time">{formatTime(candidate.timestamp, candidate.time)}</Span> <Span $className="la-message">{candidate.message}</Span>
                </ClickableDiv>
              ))}
            </Div>
          </>
        )}
      </Div>

      <Div $flex={{ gap: "xs", verticalAlign: "center" }} $className="la-detail-foot">
        <PlainButton $className="la-btn" Icon={OpenInBrowserIcon} onClick={() => void goTo.resource(resource)}>
          Open {resource.kind}
        </PlainButton>
        <Span $flexChild />
        <PrimaryButton $className={["la-btn", "la-btn--accent"]} Icon={AskAiIcon} onClick={() => void askAiAboutLogs.aboutLine(session, line)}>
          Ask AI
        </PrimaryButton>
      </Div>
    </Div>
  );
});

const Attribute = ({ name, children }: { readonly name: string; readonly children: React.ReactNode }) => (
  <Div $flex={{ gap: "s", verticalAlign: "center" }} $className="la-attr">
    <Span $className="la-attr-name">{name}</Span>
    <Span $flexChild $flex={{ gap: "xxs", verticalAlign: "center" }} $className="la-attr-value">
      {children}
    </Span>
  </Div>
);
