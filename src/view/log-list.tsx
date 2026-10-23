import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import {
  FilterAltIcon,
  InfoOutlineIcon,
  OpenInBrowserIcon,
  ScheduleIcon,
  SpinnerIcon,
  SubjectIcon,
  VisibilityIcon,
  VisibilityOffIcon,
  WarningIcon,
} from "@k8slens/icon";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { askAiAboutLogsInjectable } from "../ask-ai-about-logs.injectable";
import { clustersInjectable } from "../clusters.injectable";
import { columnTitles, columnWidthsInjectable, type ResizableColumn } from "../column-widths.injectable";
import { goToInjectable } from "../go-to.injectable";
import { firstLineOf, limits, type LogLine, messageOf } from "../model";
import type { Session } from "../session.injectable";
import { ActionIcon } from "./action-icon";
import { AlarmsList } from "./alarms-list";
import { ClusterDot } from "./cluster-dot";
import { hueOf } from "./hue";
import { formatDate, splitSource } from "./format";
import { PatternsList } from "./patterns-list";

export const LogList = observer(({ session }: { readonly session: Session }) => {
  if (!session.isReady.get()) {
    return <Centered>Loading…</Centered>;
  }

  if (session.clusterIds.get().length === 0) {
    return (
      <Centered>
        <SubjectIcon $size="xl" $color="textMuted" />
        <Span $font={{ size: "l" }}>No cluster is connected</Span>
        <Span $color="textMuted">Connect a cluster in Lens, or add one here: its logs and events are read with kubectl, nothing is installed in it.</Span>
        <PrimaryButton onClick={() => session.openPicker("cluster")}>Add a cluster</PrimaryButton>
      </Centered>
    );
  }

  return (
    <Div $flex={{ direction: "vertical" }} $flexChild $className="la-body">
      <Notices session={session} />
      {session.view.get() === "alarms" ? (
        <AlarmsList session={session} />
      ) : session.view.get() === "patterns" ? (
        <PatternsList session={session} />
      ) : (
        <Lines session={session} />
      )}
    </Div>
  );
});

const Centered = ({ children }: { readonly children: React.ReactNode }) => (
  <Div
    $flex={{ direction: "vertical", gap: "m", horizontalAlign: "center", verticalAlign: "center" }}
    $flexChild
    $padding="xl"
    $textAlign="center"
  >
    {children}
  </Div>
);

const Notice = ({ children }: { readonly children: React.ReactNode }) => (
  <Div $flex={{ gap: "s", verticalAlign: "center" }} $padding={{ horizontal: "m", vertical: "xs" }} $className="la-notice">
    {children}
  </Div>
);

/** What the tab could not read, said once and plainly, with the way to fix it where there is one. */
const Notices = observer(({ session }: { readonly session: Session }) => {
  const clusterContexts = useInject(clustersInjectable)();
  const unreadable = session.unreadable.get();

  return (
    <>
      {session.inventoryErrors.get().map(({ clusterId, error }) => (
        <Notice key={clusterId}>
          <WarningIcon $size="s" $color="warning" />
          <Span $flexChild $className="la-problem">
            {clusterContexts.nameOf(clusterId)}: {error}
          </Span>
        </Notice>
      ))}
      {session.coverage.get().map(({ clusterId, podsRead, podsTotal }) => (
        <Notice key={clusterId}>
          <InfoOutlineIcon $size="s" $color="textMuted" />
          <Span $flexChild $color="textMuted">
            {clusterContexts.nameOf(clusterId)}: reading {podsRead} of {podsTotal} pods, the ones in trouble first. Narrow to a namespace to read the rest.
          </Span>
          <PlainButton $className="la-btn" onClick={() => session.openPicker("namespace")}>Pick namespace</PlainButton>
        </Notice>
      ))}
      {session.problems.get().slice(0, 4).map(({ key, clusterId, problem }, index) => (
        <Notice key={`${key}-${index}`}>
          <WarningIcon $size="xs" $color="warning" />
          <Span $flexChild $color="textMuted" $className="la-problem">
            {clusterContexts.nameOf(clusterId)}: {problem}
          </Span>
        </Notice>
      ))}
      {session.previousNotice.get() && (
        <Notice>
          <InfoOutlineIcon $size="xs" $color="textMuted" />
          <Span $flexChild $color="textMuted">
            {session.previousNotice.get()}
          </Span>
          <PlainButton $className="la-btn" onClick={() => session.dismissPreviousNotice()}>
            OK
          </PlainButton>
        </Notice>
      )}
      {session.windowSeconds.get() > limits.eventRetentionSeconds && (
        <Notice>
          <InfoOutlineIcon $size="xs" $color="textMuted" />
          <Span $flexChild $color="textMuted">
            Kubernetes keeps events for about an hour, so older Warning events are gone; logs go back as far as the containers keep them.
          </Span>
        </Notice>
      )}
      {unreadable > 0 && session.view.get() === "timeline" && (
        <Notice>
          <InfoOutlineIcon $size="xs" $color="textMuted" />
          <Span $flexChild $color="textMuted">
            {unreadable} containers have no logs yet (starting, or never started). Their events are in Alarms.
          </Span>
        </Notice>
      )}
    </>
  );
});

export const rowHeight = 26;
const overscan = 30;

/** The lines in the order the list shows them: newest first unless the date column was flipped. */
export const displayedLines = (session: Session) => {
  const filtered = session.filtered.get();

  return session.newestFirst.get() ? [...filtered].reverse() : filtered;
};

type ColumnWidths = ReturnType<ReturnType<(typeof columnWidthsInjectable)["instantiate"]>>;

/** Fixed columns as wide as the user dragged them, without the hidden ones; the content takes what is left. */
const columnsOf = (widths: ColumnWidths) =>
  [
    "4px 74px",
    ...(["date", "cluster", "namespace", "pod"] as const)
      .filter((column) => !widths.isHidden(column))
      .map((column) => `${widths.widthOf(column)}px`),
    "minmax(120px, 1fr)",
  ].join(" ");

/** A header cell with a handle on its right edge: drag it to resize the column, double click it to put it back; hover it to hide it. */
const ResizableHeader = observer(
  ({ column, widths, className, title, onClick, children }: {
    readonly column: ResizableColumn;
    readonly widths: ColumnWidths;
    readonly className?: string;
    readonly title?: string;
    readonly onClick?: () => void;
    readonly children: React.ReactNode;
  }) => (
    <span className={`la-th la-th--resizable ${className ?? ""}`} title={title} onClick={onClick}>
      {children}
      <span
        className="la-col-hide"
        title={`Hide the ${columnTitles[column]} column`}
        onClick={(event) => {
          event.stopPropagation();
          widths.hide(column);
        }}
      >
        <VisibilityOffIcon $size="xs" />
      </span>
      <span
        className="la-col-resizer"
        title="Drag to resize; double click for the default width"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          widths.reset(column);
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();

          const startX = event.clientX;
          const startWidth = widths.widthOf(column);
          const move = (moved: PointerEvent) => widths.drag(column, startWidth + moved.clientX - startX);
          const end = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
            document.body.classList.remove("la-resizing");
            widths.commit(column);
          };

          // Followed on the window, so the pointer may run ahead of the handle while it moves.
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", end);
          window.addEventListener("pointercancel", end);
          document.body.classList.add("la-resizing");
        }}
      />
    </span>
  ),
);

/** Every line, one row each, only the rows on screen rendered; it follows the newest while scrolled to them. */
const Lines = observer(({ session }: { readonly session: Session }) => {
  const lines = displayedLines(session);
  const newestFirst = session.newestFirst.get();
  const widths = useInject(columnWidthsInjectable)();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const stick = useRef(true);
  const selectedId = session.selectedLine.get()?.id;

  useLayoutEffect(() => {
    const element = scroller.current;

    if (element && stick.current) {
      element.scrollTop = newestFirst ? 0 : element.scrollHeight;
    }
  }, [lines.length, newestFirst]);

  // Stepping through the lines with the arrows keeps the one picked on screen.
  useLayoutEffect(() => {
    const element = scroller.current;
    const index = selectedId === undefined ? -1 : lines.findIndex((line) => line.id === selectedId);

    if (!element || index < 0) {
      return;
    }

    const top = index * rowHeight;

    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight;
    }
  }, [selectedId]);

  useEffect(() => {
    const element = scroller.current;

    if (!element) {
      return undefined;
    }

    const observer = new ResizeObserver(() => setView((current) => ({ ...current, height: element.clientHeight })));

    observer.observe(element);

    return () => observer.disconnect();
  }, [lines.length === 0]);

  const columns = { gridTemplateColumns: columnsOf(widths) };
  const hidden = widths.hidden();

  const header = (
    <div className="la-table-head" style={columns}>
      <span />
      <span>
        {hidden.length > 0 && (
          <span
            className="la-col-show"
            title={`Show the hidden columns: ${hidden.map((column) => columnTitles[column]).join(", ")}`}
            onClick={() => widths.showAll()}
          >
            <VisibilityIcon $size="xs" /> {hidden.length}
          </span>
        )}
      </span>
      {!widths.isHidden("date") && <ResizableHeader
        column="date"
        widths={widths}
        className="la-th--sortable"
        title={newestFirst ? "Newest first. Click for oldest first." : "Oldest first. Click for newest first."}
        onClick={() => {
          stick.current = true;
          session.newestFirst.set(!newestFirst);
        }}
      >
        {newestFirst ? "↓" : "↑"} Date
      </ResizableHeader>}
      {(["cluster", "namespace", "pod"] as const).map(
        (column) =>
          !widths.isHidden(column) && (
            <ResizableHeader key={column} column={column} widths={widths}>
              {columnTitles[column]}
            </ResizableHeader>
          ),
      )}
      <span className="la-th">Content</span>
    </div>
  );

  if (lines.length === 0) {
    if (session.isLoading.get() || session.loadedAt.get() === undefined) {
      return (
        <Div $flex={{ direction: "vertical" }} $flexChild $className="la-table">
          {header}
          <Centered>
            <SpinnerIcon $size="l" />
            <Span $color="textMuted">Reading logs and events…</Span>
          </Centered>
        </Div>
      );
    }

    return (
      <Div $flex={{ direction: "vertical" }} $flexChild $className="la-table">
        {header}
        <Centered>
          <Span $font={{ size: "l" }}>
            {session.merged.get().length === 0
              ? "No logs in this time range"
              : session.timeRange.get()
                ? "No logs in the stretch of time picked on the histogram"
                : "No logs match your filters"}
          </Span>
          {session.timeRange.get() ? (
            <PlainButton $className="la-btn" onClick={() => session.setTimeRange(undefined)}>Show the whole time range</PlainButton>
          ) : session.merged.get().length > 0 ? (
            <PlainButton $className="la-btn" onClick={() => session.clearFilters()}>Clear filters</PlainButton>
          ) : (
            <PlainButton $className="la-btn" onClick={() => session.setWindow(3600)}>Look at the past hour</PlainButton>
          )}
        </Centered>
      </Div>
    );
  }

  const first = Math.max(0, Math.floor(view.top / rowHeight) - overscan);
  const last = Math.min(lines.length, Math.ceil((view.top + view.height) / rowHeight) + overscan);

  return (
    <Div $flex={{ direction: "vertical" }} $flexChild $className="la-table">
      {header}
      <div
        ref={scroller}
        className="la-lines"
        onScroll={(event) => {
          const element = event.currentTarget;

          stick.current = newestFirst
            ? element.scrollTop < rowHeight * 2
            : element.scrollHeight - element.scrollTop - element.clientHeight < rowHeight * 2;
          setView({ top: element.scrollTop, height: element.clientHeight });
        }}
      >
        <div className="la-lines-inner" style={{ height: lines.length * rowHeight }}>
          {lines.slice(first, last).map((line, offset) => (
            <Row key={line.id} line={line} session={session} top={(first + offset) * rowHeight} columns={columns} />
          ))}
        </div>
      </div>
    </Div>
  );
});

const Highlighted = observer(({ text, session }: { readonly text: string; readonly session: Session }) => {
  const pattern = session.matcher.get();

  if (!pattern) {
    return <>{text}</>;
  }

  const parts: React.ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    if (match[0] === "") {
      break;
    }

    parts.push(text.slice(last, match.index), <mark key={match.index}>{match[0]}</mark>);
    last = match.index + match[0].length;
  }

  parts.push(text.slice(last));

  return <>{parts}</>;
});

/** The fields shown next to a structured line's message: the ones filtered on, then a few common ones. */
const fieldsShown = (line: LogLine, session: Session) => {
  if (!line.fields) {
    return [];
  }

  const filteredOn = [...session.facetFilters.keys()].filter((key) => key.startsWith("field:")).map((key) => key.slice("field:".length));
  const preferred = [...filteredOn, "logger", "component", "application", "status", "method", "path", "code", "duration", "ms"];
  const message = line.fields.msg ?? line.fields.message;

  return [...new Set(preferred)]
    .filter((key) => line.fields![key] !== undefined && line.fields![key] !== message)
    .slice(0, 3)
    .map((key) => [key, line.fields![key]] as const);
};

const levelNames: Readonly<Record<LogLine["level"], string>> = { error: "Error", warn: "Warning", info: "Info", debug: "Debug" };

/** What the coloured bar at the start of a row says. */
const levelTitle = (line: LogLine) =>
  line.event ? `${levelNames[line.level]}: Kubernetes Warning event (${line.event.reason})` : `${levelNames[line.level]} log`;

interface RowProps {
  readonly line: LogLine;
  readonly session: Session;
  readonly top: number;
  readonly columns: React.CSSProperties;
}

const Row = observer(({ line, session, top, columns }: RowProps) => {
  const askAiAboutLogs = useInject(askAiAboutLogsInjectable)();
  const goTo = useInject(goToInjectable)();
  const clusterContexts = useInject(clustersInjectable)();
  const widths = useInject(columnWidthsInjectable)();
  const resource = session.resourceOfLine(line);
  const selected = session.selectedLine.get()?.id === line.id;
  const { source, rest } = splitSource(firstLineOf(messageOf(line)));
  const [opening, setOpening] = useState(false);
  const podColour = `hsl(${hueOf(line.pod)} 70% 68%)`;

  return (
    <div
      className={`la-row la-row--${line.level}${line.event ? " la-row--event" : ""}${selected ? " la-row--selected" : ""}`}
      style={{ ...columns, top }}
      onClick={() => session.select(selected ? undefined : line.id)}
    >
      <span className="la-row-bar" title={levelTitle(line)} />
      <span className="la-row-tools">
      <span
        className="la-row-icon"
        title="Open the details of this log"
        onClick={(event) => {
          event.stopPropagation();
          session.select(line.id);
        }}
      >
        <InfoOutlineIcon $size="m" />
      </span>
      <span
        className="la-row-icon"
        title={
          opening
            ? "Opening in Lens…"
            : line.event
              ? `Open the event ${line.event.name} in Lens`
              : `Open ${resource.kind} ${resource.namespace}/${resource.name} in Lens`
        }
        onClick={(event) => {
          event.stopPropagation();

          if (opening) {
            return;
          }

          // Lens loads the cluster's views first, which can take a few seconds: say it is on its way.
          setOpening(true);
          void (line.event ? goTo.event(line.clusterId, line.event) : goTo.resource(resource)).finally(() => setOpening(false));
        }}
      >
        {opening ? <SpinnerIcon $size="s" /> : <OpenInBrowserIcon $size="m" />}
      </span>
      <span
        className="la-row-icon la-row-icon--ai"
        title="Investigate this log with Ask AI"
        onClick={(event) => {
          event.stopPropagation();
          void askAiAboutLogs.aboutLine(session, line);
        }}
      >
        ✳
      </span>
      </span>
      {!widths.isHidden("date") && (
        <Span $className="la-date" $tooltip={line.time}>
          {formatDate(line.timestamp, line.time)}
        </Span>
      )}
      {!widths.isHidden("cluster") && (
        <span className="la-cluster">
          <ClusterDot clusterId={line.clusterId} />
          <span className="la-cluster-name">{clusterContexts.nameOf(line.clusterId)}</span>
        </span>
      )}
      {!widths.isHidden("namespace") && <span className="la-ns">{line.namespace}</span>}
      {!widths.isHidden("pod") && <span
        className="la-pod"
        style={{ color: podColour }}
        title={line.event ? `Event about ${line.event.involvedKind} ${line.namespace}/${line.pod}` : `${line.namespace}/${line.pod}, container ${line.container}`}
      >
        <span className="la-pod-dot" style={{ background: podColour }} />
        <span className="la-pod-name">{line.event ? `event ${line.event.involvedKind.toLowerCase()}/${line.pod}` : line.pod}</span>
        {line.previous && (
          <span className="la-badge la-badge--prev" title="From the run before the container's last restart">
            prev
          </span>
        )}
      </span>}
      <span className="la-message">
        {source && (
          <span className="la-source">
            <Highlighted text={source} session={session} />
          </span>
        )}
        <span className="la-text">
          <Highlighted text={rest} session={session} />
        </span>
        {line.continuation && (
          <span className="la-badge la-badge--more" title="A stack trace or multi-line message: open the details to read it whole">
            +{line.continuation} lines
          </span>
        )}
        {fieldsShown(line, session).map(([key, value]) => (
          <span key={key} className="la-kv">
            <span className="la-kv-k">{key}</span>
            {value}
          </span>
        ))}
      </span>
      <span className="la-actions" onClick={(event) => event.stopPropagation()}>
        {!line.event && (
          <>
            <ActionIcon $onClick={() => session.onlyPod(line)} $tooltip="Only this pod">
              <FilterAltIcon />
            </ActionIcon>
            <ActionIcon
              $onClick={() => session.onlyContainer(line)}
              $tooltip={`Only container ${line.container} of this pod`}
            >
              <SubjectIcon />
            </ActionIcon>
            <ActionIcon $onClick={() => session.hidePod(line)} $tooltip="Hide this pod">
              <VisibilityOffIcon />
            </ActionIcon>
          </>
        )}
        <span className="la-actions-divider" />
        <ClickableDiv
          $className="la-mini"
          $flex={{ gap: "xxs", verticalAlign: "center" }}
          $onClick={() => void goTo.resource(resource)}
          $tooltip={`Open ${resource.kind} ${resource.namespace}/${resource.name} in Lens`}
        >
          <OpenInBrowserIcon $size="xs" />
          <span className="la-mini-text">
            {resource.kind} {resource.name}
          </span>
        </ClickableDiv>
        {line.event && (
          <ClickableDiv
            $className="la-mini"
            $flex={{ gap: "xxs", verticalAlign: "center" }}
            $onClick={() => void goTo.event(line.clusterId, line.event!)}
            $tooltip={`Open the event ${line.event.name}`}
          >
            <ScheduleIcon $size="xs" />
            <span>Event</span>
          </ClickableDiv>
        )}
      </span>
    </div>
  );
});
