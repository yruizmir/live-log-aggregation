import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import { observer } from "mobx-react";
import type React from "react";
import { firstLineOf, maskMessage, messageOf } from "../model";
import type { Pattern, Session } from "../session.injectable";
import { shortTime } from "./format";

/** The tokens `messageShape` puts where a message varies, shown as placeholders. */
const tokenPattern = /(<id>|<time>|#)/g;

const Shape = ({ shape }: { readonly shape: string }) => {
  const parts: React.ReactNode[] = [];
  let last = 0;

  for (const match of shape.matchAll(tokenPattern)) {
    parts.push(shape.slice(last, match.index));
    parts.push(
      <span key={match.index} className="la-token">
        {match[0] === "#" ? "#" : match[0].slice(1, -1)}
      </span>,
    );
    last = match.index + match[0].length;
  }

  parts.push(shape.slice(last));

  return <>{parts}</>;
};

const Sparkline = ({ series }: { readonly series: readonly number[] }) => {
  const highest = Math.max(1, ...series);
  const width = 80;
  const height = 18;
  const step = width / Math.max(1, series.length - 1);
  const points = series.map((value, index) => `${(index * step).toFixed(1)},${(height - 1 - (value / highest) * (height - 2)).toFixed(1)}`).join(" ");

  return (
    <svg className="la-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={points} fill="none" strokeWidth="1.5" />
    </svg>
  );
};

/** Datadog's Patterns view: the lines grouped by what they say, the loudest first. */
export const PatternsList = observer(({ session }: { readonly session: Session }) => {
  const patterns = session.patterns.get();
  const total = session.filtered.get().length;

  if (patterns.length === 0) {
    return (
      <Div $flexChild $flex={{ horizontalAlign: "center", verticalAlign: "center" }} $padding="xl">
        <Span $color="textMuted">No lines to group into patterns.</Span>
      </Div>
    );
  }

  return (
    <Div $flexChild $flex={{ direction: "vertical" }} $className="la-patterns">
      <Div $flex={{ gap: "m", verticalAlign: "center" }} $className={["la-pattern", "la-pattern--head"]}>
        <Span $className="la-pattern-count">Count</Span>
        <Span $className="la-pattern-spark">Trend</Span>
        <Span $flexChild>
          {patterns.length.toLocaleString()} patterns in {total.toLocaleString()} lines
        </Span>
        <Span $className="la-pattern-meta">Pods · last seen</Span>
      </Div>
      {patterns.slice(0, 500).map((pattern) => (
        <PatternRow key={pattern.shape} pattern={pattern} total={total} session={session} />
      ))}
    </Div>
  );
});

const PatternRow = ({ pattern, total, session }: { readonly pattern: Pattern; readonly total: number; readonly session: Session }) => (
  <ClickableDiv
    $flex={{ gap: "m", verticalAlign: "center" }}
    $className={["la-pattern", `la-pattern--${pattern.level}`]}
    $onClick={() => session.filterPattern(pattern)}
    $tooltip={`Example: ${pattern.sample.message.slice(0, 400)}`}
  >
    <Span $className="la-pattern-count">
      <b>{pattern.count.toLocaleString()}</b>
      <Span $className="la-pattern-share">{Math.round((pattern.count / Math.max(1, total)) * 100)}%</Span>
    </Span>
    <Span $className="la-pattern-spark">
      <Sparkline series={pattern.series} />
    </Span>
    <Span $flexChild $className="la-pattern-shape">
      <Span $className={["la-level-dot", `la-level-dot--${pattern.level}`]} /> <Shape shape={maskMessage(firstLineOf(messageOf(pattern.sample)))} />
    </Span>
    <Span $className="la-pattern-meta">
      {pattern.pods} · {shortTime.format(pattern.lastSeen)}
    </Span>
  </ClickableDiv>
);
