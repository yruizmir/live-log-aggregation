import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import {
  CloseIcon,
  PlayArrowIcon,
  RefreshIcon,
  SpinnerIcon,
} from "@k8slens/icon";
import { TextInput } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import type React from "react";
import { clustersInjectable } from "../clusters.injectable";
import { limits, liveIntervals, sourceGroupKey, timeWindows } from "../model";
import type { LevelFilter, Picker, Session } from "../session.injectable";
import { ActionIcon } from "./action-icon";
import { ClusterDot } from "./cluster-dot";

const windowNames: Readonly<Record<number, string>> = {
  300: "Past 5 minutes",
  900: "Past 15 minutes",
  3600: "Past 1 hour",
  21_600: "Past 6 hours",
  86_400: "Past 1 day",
};

const liveIntervalNames: Readonly<Record<number, string>> = {
  10: "Every 10 seconds",
  30: "Every 30 seconds",
  60: "Every minute",
  300: "Every 5 minutes",
};

const levels: readonly {
  readonly id: LevelFilter;
  readonly label: string;
  readonly count: "all" | "warn" | "error";
}[] = [
  { id: "all", label: "All", count: "all" },
  { id: "warn", label: "Warn+", count: "warn" },
  { id: "error", label: "Errors", count: "error" },
];

/** What a filter reads, said on its button: "All", one name, or the first name and how many more. */
const summary = (names: readonly string[], all = "All") =>
  names.length === 0
    ? all
    : `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}`;

/**
 * The top bar: what is read (clusters, namespaces, resources, each "All" until narrowed), how
 * much of it is shown (level, with counts), how far back, and Live / Refresh.
 */
export const ScopeBar = observer(
  ({ session }: { readonly session: Session }) => {
    const clusterContexts = useInject(clustersInjectable)();
    const scope = session.scope.get();
    const picker = session.picker.get();
    const counts = session.levelCounts.get();
    const window =
      timeWindows.find(
        (candidate) => candidate.seconds === session.windowSeconds.get(),
      ) ?? timeWindows[0];
    const live = session.live.get();
    const liveIntervalName = liveIntervals.find((candidate) => candidate.seconds === session.liveIntervalSeconds.get())?.label ?? `${session.liveIntervalSeconds.get()}s`;

    return (
      <Div
        $flex={{ gap: "s", verticalAlign: "center" }}
        $className={["la-bar", "la-bar--scope"]}
      >
        <Filter
          label=""
          session={session}
          picker="cluster"
          open={picker === "cluster"}
        >
          {scope.clusterIds.length === 0
            ? session.clusterIds
                .get()
                .slice(0, 3)
                .map((clusterId) => (
                  <ClusterDot key={clusterId} clusterId={clusterId} />
                ))
            : scope.clusterIds
                .slice(0, 3)
                .map((clusterId) => (
                  <ClusterDot key={clusterId} clusterId={clusterId} />
                ))}
          <Span>
            {summary(
              scope.clusterIds.map((clusterId) =>
                clusterContexts.nameOf(clusterId),
              ),
              "All clusters",
            )}
          </Span>
        </Filter>

        <Filter
          label="Namespaces"
          session={session}
          picker="namespace"
          open={picker === "namespace"}
        >
          <Span>{summary(scope.namespaces)}</Span>
        </Filter>

        <Filter
          label="Resources"
          session={session}
          picker="source"
          open={picker === "source"}
        >
          <Span>
            {summary(
              session.groupedSources.get().map((group) => group.first.name),
            )}
          </Span>
        </Filter>

        <Div
          $flex={{ gap: "s", verticalAlign: "center" }}
          $className="la-scope-right"
        >
          <Div $flex $className={["la-segmented", "la-levels"]}>
            {levels.map((option) => (
              <ClickableDiv
                key={option.id}
                $flex={{ gap: "xs", verticalAlign: "center" }}
                $className={[
                  "la-segment",
                  `la-segment--${option.id}`,
                  { "la-segment--active": option.id === session.level.get() },
                ]}
                $onClick={() => session.level.set(option.id)}
              >
                <Span
                  $className={[
                    "la-level-square",
                    `la-level-square--${option.id}`,
                  ]}
                />
                <Span>{option.label}</Span>
                <Span $className="la-segment-count">
                  {counts[option.count].toLocaleString()}
                </Span>
              </ClickableDiv>
            ))}
          </Div>

          <Div $anchor>
            <ClickableDiv
              $flex={{ gap: "s", verticalAlign: "center" }}
              $className={[
                "la-select",
                "la-select--time",
                { "la-select--open": picker === "time" },
              ]}
              $onClick={() =>
                picker === "time"
                  ? session.closePicker()
                  : session.openPicker("time")
              }
              $tooltip={`${windowNames[window.seconds]}: how far back to read`}
            >
              <Span $className="la-time-badge">{window.label}</Span>
              <Span $className="la-caret">▾</Span>
            </ClickableDiv>
            {picker === "time" && (
              <Popover session={session} narrow>
                {timeWindows.map((candidate) => (
                  <ClickableDiv
                    key={candidate.seconds}
                    $flex={{ gap: "s", verticalAlign: "center" }}
                    $className={[
                      "la-option",
                      {
                        "la-option--active":
                          candidate.seconds === window.seconds,
                      },
                    ]}
                    $onClick={() => {
                      session.setWindow(candidate.seconds);
                      session.closePicker();
                    }}
                  >
                    <Span $className="la-time-badge">{candidate.label}</Span>
                    <Span>{windowNames[candidate.seconds]}</Span>
                  </ClickableDiv>
                ))}
              </Popover>
            )}
          </Div>

          <Div $anchor $flex={{ verticalAlign: "center" }} $className={["la-live", { "la-live--on": live }]}>
            <ActionIcon
              $onClick={() => session.toggleLive()}
              $tooltip={
                live
                  ? `Live: reading again every ${liveIntervalName}. Click to pause.`
                  : `Paused. Click to go live: read again every ${liveIntervalName}.`
              }
              $className={[
                "la-square-button",
                "la-live-button",
                { "la-square-button--live": live },
              ]}
            >
              {live ? <span className="la-pause-glyph" /> : <PlayArrowIcon />}
            </ActionIcon>
            <ClickableDiv
              $flex={{ verticalAlign: "center" }}
              $className={["la-live-caret", { "la-live-caret--open": picker === "live" }]}
              $onClick={() => (picker === "live" ? session.closePicker() : session.openPicker("live"))}
              $tooltip={`Logs capture resolution: every ${liveIntervalName}`}
            >
              <Span $className="la-caret">▾</Span>
            </ClickableDiv>
            {picker === "live" && (
              <Popover session={session} narrow>
                <Div $className="la-popover-title">Logs capture resolution</Div>
                {liveIntervals.map((candidate) => (
                  <ClickableDiv
                    key={candidate.seconds}
                    $flex={{ gap: "s", verticalAlign: "center" }}
                    $className={[
                      "la-option",
                      { "la-option--active": candidate.seconds === session.liveIntervalSeconds.get() },
                    ]}
                    $onClick={() => {
                      session.setLiveInterval(candidate.seconds);
                      session.closePicker();
                    }}
                  >
                    <Span $className="la-time-badge">{candidate.label}</Span>
                    <Span>{liveIntervalNames[candidate.seconds]}</Span>
                  </ClickableDiv>
                ))}
              </Popover>
            )}
          </Div>

          <ActionIcon
            $onClick={() => session.refresh()}
            $tooltip="Read again now: what is new since the last read"
            $className="la-square-button"
          >
            {session.isLoading.get() ? <SpinnerIcon /> : <RefreshIcon />}
          </ActionIcon>
        </Div>
      </Div>
    );
  },
);

interface FilterProps {
  readonly label: string;
  readonly session: Session;
  readonly picker: Picker;
  readonly open: boolean;
  readonly children: React.ReactNode;
}

const Filter = observer(
  ({ label, session, picker, open, children }: FilterProps) => {
    return (
      <Div $flex={{ gap: "s", verticalAlign: "center" }} $anchor>
        {label && <Span $className="la-bar-label">{label}</Span>}
        <ClickableDiv
          $flex={{ gap: "s", verticalAlign: "center" }}
          $className={["la-select", { "la-select--open": open }]}
          $onClick={() =>
            open ? session.closePicker() : session.openPicker(picker)
          }
        >
          {children}
          <Span $className="la-caret">▾</Span>
        </ClickableDiv>
        {open && picker === "cluster" && <ClusterPicker session={session} />}
        {open && picker === "namespace" && (
          <NamespacePicker session={session} />
        )}
        {open && picker === "source" && <SourcePicker session={session} />}
      </Div>
    );
  },
);

const Check = ({ on }: { readonly on: boolean }) => (
  <Span $className={["la-check", { "la-check--on": on }]}>{on ? "✓" : ""}</Span>
);

interface CheckRowProps {
  readonly on: boolean;
  readonly onToggle: () => void;
  readonly enabled?: boolean;
  readonly tooltip?: string;
  readonly children: React.ReactNode;
}

/** One choice of a multiple choice: ticked or not, a click flips it and the list stays open. */
const CheckRow = ({ on, onToggle, enabled = true, tooltip, children }: CheckRowProps) => (
  <ClickableDiv
    $flex={{ gap: "s", verticalAlign: "center" }}
    $className={["la-option", { "la-option--checked": on }]}
    $onClick={onToggle}
    $enabled={enabled}
    $tooltip={tooltip}
  >
    <Check on={on} />
    {children}
  </ClickableDiv>
);

const Popover = ({
  session,
  children,
  narrow,
}: {
  readonly session: Session;
  readonly children: React.ReactNode;
  readonly narrow?: boolean;
}) => (
  <Div
    $anchoredAt="bottom span-right"
    $onOutsideClick={() => session.closePicker()}
    $backgroundColor="backgroundSecondary"
    $border={{ color: "borderPrimary", width: "xxs", radius: "m" }}
    $boxShadow
    $padding="s"
    $flex={{ direction: "vertical", gap: "xs" }}
    $className={["la-popover", { "la-popover--narrow": narrow }]}
  >
    {children}
  </Div>
);

const Search = observer(
  ({
    session,
    placeholder,
  }: {
    readonly session: Session;
    readonly placeholder: string;
  }) => (
    <TextInput
      autoFocus
      type="search"
      placeholder={placeholder}
      value={session.pickerQuery.get()}
      onChange={(event) => session.pickerQuery.set(event.target.value)}
    />
  ),
);

const ClusterPicker = observer(({ session }: { readonly session: Session }) => {
  const clusterContexts = useInject(clustersInjectable)();
  const wanted = session.pickerQuery.get().trim().toLowerCase();
  const picked = session.scope.get().clusterIds;
  const full = picked.length >= limits.maxClusters;
  const clusters = clusterContexts.clusters
    .get()
    .filter((cluster) => !wanted || cluster.name.get().toLowerCase().includes(wanted))
    .slice()
    .sort((left, right) => left.name.get().localeCompare(right.name.get(), undefined, { sensitivity: "base" }));

  return (
    <Popover session={session}>
      <Search session={session} placeholder="Find a cluster" />
      <Div $flex={{ direction: "vertical" }} $className="la-popover-list">
        <CheckRow on={picked.length === 0} onToggle={() => session.resetClusters()}>
          <Span $flexChild>All connected clusters</Span>
        </CheckRow>
        {clusters.map((cluster) => {
          const on = picked.includes(cluster.id);

          return (
            <CheckRow
              key={cluster.id}
              on={on}
              enabled={on || !full}
              tooltip={!on && full ? `At most ${limits.maxClusters} clusters at a time` : undefined}
              onToggle={() => (on ? session.removeCluster(cluster.id) : session.addCluster(cluster.id))}
            >
              <ClusterDot clusterId={cluster.id} />
              <Span $flexChild>{cluster.name.get()}</Span>
              {cluster.isConnected.get() && (
                <Span $color="textMuted" $className="la-option-hint">
                  connected
                </Span>
              )}
            </CheckRow>
          );
        })}
      </Div>
    </Popover>
  );
});

const NamespacePicker = observer(({ session }: { readonly session: Session }) => {
  const picked = session.scope.get().namespaces;
  const namespaces = session.namespaceCandidates.get();

  return (
    <Popover session={session}>
      <Search session={session} placeholder="Find a namespace" />
      <Div $flex={{ direction: "vertical" }} $className="la-popover-list">
        <CheckRow on={session.scope.get().namespaces.length === 0} onToggle={() => session.resetNamespaces()}>
          <Span $flexChild>All namespaces</Span>
        </CheckRow>
        {namespaces.map(({ namespace, pods }) => (
          <CheckRow
            key={namespace}
            on={picked.includes(namespace)}
            onToggle={() => (picked.includes(namespace) ? session.removeNamespace(namespace) : session.addNamespace(namespace))}
          >
            <Span $flexChild>{namespace}</Span>
            <Span $color="textMuted" $className="la-option-hint">
              {pods} pods
            </Span>
          </CheckRow>
        ))}
        {namespaces.length === 0 && (
          <Span $color="textMuted" $className="la-option-empty">
            {session.isLoading.get() ? "Reading the clusters…" : "Nothing matches"}
          </Span>
        )}
      </Div>
    </Popover>
  );
});

const SourcePicker = observer(({ session }: { readonly session: Session }) => {
  const clusterContexts = useInject(clustersInjectable)();
  const candidates = session.sourceCandidates.get();
  const pickedKeys = new Set(session.groupedSources.get().map((group) => group.key));

  return (
    <Popover session={session}>
      <Search session={session} placeholder="Find a deployment, statefulset, daemonset, job or pod" />
      <Div $flex={{ direction: "vertical" }} $className="la-popover-list">
        <CheckRow on={session.scope.get().sources.length === 0} onToggle={() => session.resetSources()}>
          <Span $flexChild>All workloads and pods</Span>
        </CheckRow>
        {candidates.map((candidate) => (
          <CheckRow
            key={`${candidate.kind}|${candidate.namespace}|${candidate.name}`}
            on={pickedKeys.has(sourceGroupKey(candidate))}
            onToggle={() =>
              pickedKeys.has(sourceGroupKey(candidate)) ? session.removeSourceGroup(sourceGroupKey(candidate)) : session.addSource(candidate)
            }
            tooltip={
              candidate.clusterIds.length > 1
                ? `Adds it in ${candidate.clusterIds.map((clusterId) => clusterContexts.nameOf(clusterId)).join(", ")}`
                : undefined
            }
          >
            <Span $color="textMuted" $className="la-kind">
              {candidate.kind}
            </Span>
            <Span $flexChild>
              {candidate.namespace}/{candidate.name}
            </Span>
            {candidate.kind !== "Pod" && (
              <Span $color="textMuted" $className="la-option-hint">
                {candidate.pods} pods
              </Span>
            )}
            {candidate.clusterIds.map((clusterId) => (
              <ClusterDot key={clusterId} clusterId={clusterId} />
            ))}
          </CheckRow>
        ))}
        {candidates.length === 0 && (
          <Span $color="textMuted" $className="la-option-empty">
            {session.isLoading.get() ? "Reading the clusters…" : "Nothing matches"}
          </Span>
        )}
      </Div>
    </Popover>
  );
});
