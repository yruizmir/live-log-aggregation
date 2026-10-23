import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import { ArrowBackIcon, CloseIcon } from "@k8slens/icon";
import { PlainButton } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { runInAction } from "mobx";
import { observer } from "mobx-react";
import type React from "react";
import { askAiAboutLogsInjectable } from "../ask-ai-about-logs.injectable";
import { clustersInjectable } from "../clusters.injectable";
import { firstLineOf, messageOf } from "../model";
import type { Session, View } from "../session.injectable";
import { ActionIcon } from "./action-icon";
import { copyText, formatDate, saveFile, shortTime, toCsv } from "./format";
import { QueryInput } from "./query-input";

export const updatedAgo = (loadedAt: number | undefined, now: number) => {
  if (loadedAt === undefined) {
    return "Not read yet";
  }

  const seconds = Math.max(0, Math.round((now - loadedAt) / 1000));

  return seconds < 5 ? "updated just now" : seconds < 60 ? `updated ${seconds}s ago` : `updated ${Math.round(seconds / 60)}m ago`;
};

/** The search box, across the whole tab, and what is wrong with what was typed in it. */
export const SearchBar = observer(({ session }: { readonly session: Session }) => {
  const problems = session.queryProblems.get();

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }} $className="la-searchbar">
      <QueryInput session={session} />
      {session.matcherIsInvalid.get() && (
        <Span $color="critical" $className="la-option-hint">
          That is not a valid regular expression.
        </Span>
      )}
      {problems.map((problem) => (
        <Span key={problem} $color="warning" $className="la-option-hint">
          {problem}
        </Span>
      ))}
    </Div>
  );
});

const viewNames: Readonly<Record<View, string>> = { timeline: "logs", patterns: "patterns", alarms: "insights" };

/** How many lines are shown and how many of them are errors and warnings, what narrows them, and what to do with them. */
export const SummaryBar = observer(({ session }: { readonly session: Session }) => {
  const askAiAboutLogs = useInject(askAiAboutLogsInjectable)();
  const clusterContexts = useInject(clustersInjectable)();
  const counts = session.counts.get();
  const view = session.view.get();
  const picker = session.picker.get();
  const range = session.timeRange.get();
  // Every other filter is in the search box and the facets; the zoom of the histogram is the one that is not.
  const hasFocus = range !== undefined || session.query.get().trim() !== "" || session.level.get() !== "all";

  const downloadCsv = () => {
    const rows = session.filtered.get().map((line) => [
      Number.isNaN(line.timestamp) ? line.time : new Date(line.timestamp).toISOString(),
      clusterContexts.nameOf(line.clusterId),
      line.namespace,
      line.pod,
      line.container,
      line.level,
      line.message,
    ]);

    const csv = toCsv([["date", "cluster", "namespace", "pod", "container", "level", "message"], ...rows]);

    void saveFile(`logs-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.csv`, csv, ".csv", "CSV file").then((outcome) =>
      runInAction(() => session.previousNotice.set(outcome === "copied" ? "Lens did not let the file be saved, so the CSV is in the clipboard instead." : undefined)),
    );
  };

  return (
    <Div $flex={{ gap: "m", verticalAlign: "center" }} $className="la-summary">
      <Div $flexChild $flex={{ gap: "s", verticalAlign: "center", wrap: true }} $className="la-summary-text">
        {view === "timeline" ? (
          <Span>
            <b>{counts.lines.toLocaleString()}</b> logs found
            <Span $className="la-summary-dot"> · </Span>
            <Span $className="la-text-error">{counts.errors.toLocaleString()} errors</Span>
            <Span $className="la-summary-dot"> · </Span>
            <Span $className="la-text-warn">{counts.warnings.toLocaleString()} warnings</Span>
          </Span>
        ) : (
          <Span $flex={{ gap: "m", verticalAlign: "center" }}>
            <PlainButton $className="la-btn" Icon={ArrowBackIcon} onClick={() => session.setView("timeline")} $tooltip="Back to the timeline of logs">
              Back to logs
            </PlainButton>
            {view === "patterns" ? (
              <>
                <b>{session.patterns.get().length.toLocaleString()}</b> patterns in {counts.lines.toLocaleString()} logs
              </>
            ) : (
              <>
                <b>{session.alarms.get().length.toLocaleString()}</b> insights in this time range
              </>
            )}
          </Span>
        )}

        {range && (
          <FocusChip label="Time" onRemove={() => session.setTimeRange(undefined)}>
            {shortTime.format(range.from)} – {shortTime.format(range.to)}
          </FocusChip>
        )}
        {hasFocus && (
          <ClickableDiv $className="la-link" $onClick={() => session.clearFilters()}>
            Clear all
          </ClickableDiv>
        )}
      </Div>

      <ClickableDiv
        $flex={{ gap: "s", verticalAlign: "center" }}
        $className={["la-select", "la-select--button"]}
        $onClick={downloadCsv}
        $tooltip="Save the logs shown as a CSV file"
      >
        <Span>↓ Download as CSV</Span>
      </ClickableDiv>

      <Div $anchor>
        <ClickableDiv
          $flex={{ gap: "s", verticalAlign: "center" }}
          $className={["la-select", "la-select--button", { "la-select--open": picker === "options" }]}
          $onClick={() => (picker === "options" ? session.closePicker() : session.openPicker("options"))}
        >
          <Span>Options</Span>
          <Span $className="la-caret">▾</Span>
        </ClickableDiv>
        {picker === "options" && (
          <Div
            $anchoredAt="bottom span-left"
            $onOutsideClick={() => session.closePicker()}
            $flex={{ direction: "vertical" }}
            $className={["la-popover", "la-popover--narrow", "la-menu"]}
          >
            <MenuItem session={session} checked={view === "timeline"} onClick={() => session.setView("timeline")}>
              Show {viewNames.timeline}
            </MenuItem>
            <MenuItem session={session} checked={view === "patterns"} onClick={() => session.setView("patterns")}>
              Group logs into patterns
            </MenuItem>
            <MenuItem session={session} checked={view === "alarms"} onClick={() => session.setView("alarms")}>
              Show every insight
            </MenuItem>
            <Span $className="la-menu-divider" />
            <MenuItem session={session} checked={session.showFacets.get()} onClick={() => session.showFacets.set(!session.showFacets.get())}>
              Show facets
            </MenuItem>
            <Span $className="la-menu-divider" />
            <MenuItem
              session={session}
              onClick={() => {
                const lines = session.filtered.get();

                copyText(lines.map((line) => `${formatDate(line.timestamp, line.time)} ${line.namespace}/${line.pod} ${firstLineOf(messageOf(line))}`).join("\n"));
              }}
            >
              Copy the logs shown
            </MenuItem>
            {counts.lines > 0 && <MenuItem session={session} onClick={() => void askAiAboutLogs.aboutView(session)}>Ask AI about these logs</MenuItem>}
          </Div>
        )}
      </Div>
    </Div>
  );
});

const FocusChip = ({ label, onRemove, children }: { readonly label: string; readonly onRemove: () => void; readonly children: React.ReactNode }) => (
  <Div $className="la-chip" $flex={{ gap: "xs", verticalAlign: "center" }}>
    <Span $className="la-chip-label">{label}</Span>
    {children}
    <ActionIcon $onClick={onRemove} $tooltip="Remove">
      <CloseIcon />
    </ActionIcon>
  </Div>
);

const MenuItem = observer(
  ({ session, checked, onClick, children }: { readonly session: Session; readonly checked?: boolean; readonly onClick: () => void; readonly children: React.ReactNode }) => (
    <ClickableDiv
      $flex={{ gap: "s", verticalAlign: "center" }}
      $className="la-option"
      $onClick={() => {
        onClick();
        session.closePicker();
      }}
    >
      <Span $className="la-menu-check">{checked ? "✓" : ""}</Span>
      <Span $flexChild>{children}</Span>
    </ClickableDiv>
  ),
);
