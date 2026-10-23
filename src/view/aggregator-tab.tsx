import { Div, Span } from "@k8slens/element-components";
import { SubjectIcon } from "@k8slens/icon";
import type { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import type { TabProps } from "@k8slens/tab-contracts";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useEffect, useRef } from "react";
import { sessionInjectable } from "../session.injectable";
import { DetailPanel } from "./detail-panel";
import { FacetPanel } from "./facet-panel";
import { SearchBar, SummaryBar } from "./focus-bar";
import { Footer } from "./footer";
import { Histogram } from "./histogram";
import { Insights } from "./insights";
import { displayedLines, LogList } from "./log-list";
import { ScopeBar } from "./scope-bar";

type Props = TabProps<typeof mainViewTabHostKind>;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export const AggregatorTab = observer(({ tabId }: Props) => {
  const session = useInject(sessionInjectable)(tabId);
  const root = useRef<HTMLDivElement>(null);

  // Reads run only while the tab is on screen; leaving it stops them.
  useEffect(() => session.attach(), [session]);

  // `/` goes to the search box, the arrows step through the lines. Only while this tab is the one
  // on screen, and never while typing somewhere, a terminal included.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = root.current;

      if (!element || element.offsetParent === null || isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        element.querySelector<HTMLInputElement>(".la-query-input input, input.la-query-input")?.focus();
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && session.view.get() === "timeline") {
        const lines = displayedLines(session);
        const current = lines.findIndex((line) => line.id === session.selectedLine.get()?.id);
        const next = current < 0 ? 0 : Math.min(lines.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));

        if (lines[next]) {
          event.preventDefault();
          session.select(lines[next].id);
        }
      }
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  const reading = session.clusterIds.get().length > 0;
  const timeline = session.view.get() === "timeline";

  return (
    <div ref={root} className="la-tab-root">
      <Div $flex={{ direction: "vertical" }} $height="full" $width="full" $className="la-tab">
        <Div $flex={{ direction: "vertical" }} $className="la-top">
          <ScopeBar session={session} />
          <SearchBar session={session} />
          {reading && timeline && <Histogram session={session} />}
        </Div>
        {reading && <SummaryBar session={session} />}
        {reading && session.view.get() !== "alarms" && <Insights session={session} />}
        <Div $flex $flexChild $className="la-explorer">
          {reading && timeline && session.showFacets.get() && <FacetPanel session={session} />}
          <LogList session={session} />
          <DetailPanel session={session} />
        </Div>
        <Footer session={session} />
      </Div>
    </div>
  );
});

export const AggregatorTitle = observer(({ tabId }: Props) => {
  const session = useInject(sessionInjectable)(tabId);
  const groups = session.groupedSources.get();
  const title =
    groups.length === 0
      ? "Live Log Aggregation"
      : `Logs: ${groups[0].first.name}${groups.length > 1 ? ` +${groups.length - 1}` : ""}`;

  return (
    <Div $flex={{ gap: "xs", verticalAlign: "center" }}>
      <SubjectIcon $size="s" />
      <Span>{title}</Span>
    </Div>
  );
});
