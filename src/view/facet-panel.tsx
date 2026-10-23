import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import { CheckIcon, ChevronRightIcon, CloseIcon, RemoveCircleOutlineIcon } from "@k8slens/icon";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useState } from "react";
import { clustersInjectable } from "../clusters.injectable";
import type { FacetKey } from "../model";
import type { Facet, Session } from "../session.injectable";
import { ActionIcon } from "./action-icon";
import { ClusterDot } from "./cluster-dot";

const shownAtFirst = 8;

/** Datadog's left column: every facet with its values and how many lines have each. */
export const FacetPanel = observer(({ session }: { readonly session: Session }) => {
  const facets = session.facets.get();
  const fixed = facets.filter((facet) => !facet.key.startsWith("field:"));
  const fields = facets.filter((facet) => facet.key.startsWith("field:"));

  return (
    <Div $flex={{ direction: "vertical" }} $className="la-facets">
      {fixed.map((facet) => (
        <FacetSection key={facet.key} facet={facet} session={session} />
      ))}
      {fields.length > 0 && (
        <>
          <Span $className="la-facets-heading">Fields</Span>
          {fields.map((facet) => (
            <FacetSection key={facet.key} facet={facet} session={session} collapsedAtFirst />
          ))}
        </>
      )}
    </Div>
  );
});

const FacetSection = observer(
  ({ facet, session, collapsedAtFirst = false }: { readonly facet: Facet; readonly session: Session; readonly collapsedAtFirst?: boolean }) => {
    const filter = session.facetFilters.get(facet.key);
    const isActive = Boolean(filter && (filter.include.length > 0 || filter.exclude.length > 0));
    const [open, setOpen] = useState(!collapsedAtFirst || isActive);
    const [all, setAll] = useState(false);
    const values = all ? facet.values : facet.values.slice(0, shownAtFirst);
    const highest = Math.max(1, ...facet.values.map((value) => value.count));

    return (
      <Div $className={["la-facet", { "la-facet--active": isActive }]}>
        <ClickableDiv $flex={{ gap: "xs", verticalAlign: "center" }} $className="la-facet-title" $onClick={() => setOpen(!open)}>
          <ChevronRightIcon $size="xs" $className={["la-chevron", { "la-chevron--open": open }]} />
          <Span $flexChild>{facet.label}</Span>
          {isActive ? (
            <ActionIcon $onClick={() => session.clearFacet(facet.key)} $tooltip={`Stop filtering by ${facet.label.toLowerCase()}`} $className="la-facet-clear">
              <CloseIcon />
            </ActionIcon>
          ) : (
            <Span $className="la-facet-count">{facet.values.length}</Span>
          )}
        </ClickableDiv>

        {open && (
          <Div $flex={{ direction: "vertical" }}>
            {values.map(({ value, count }) => {
              const included = filter?.include.includes(value) ?? false;
              const excluded = filter?.exclude.includes(value) ?? false;
              const dimmed = (filter?.include.length ?? 0) > 0 && !included;

              return (
                <Div
                  key={value}
                  $flex={{ gap: "xs", verticalAlign: "center" }}
                  $className={["la-facet-row", { "la-facet-row--dim": dimmed || excluded, "la-facet-row--excluded": excluded }]}
                >
                  <div className="la-facet-bar" style={{ width: `${(count / highest) * 100}%` }} />
                  <ClickableDiv
                    $flexChild
                    $flex={{ gap: "xs", verticalAlign: "center" }}
                    $className="la-facet-pick"
                    $onClick={() => session.toggleFacet(facet.key, value)}
                    $onDoubleClick={() => session.onlyFacet(facet.key, value)}
                    $tooltip="Click to keep, double click for only this one"
                  >
                    <Span $className={["la-check", { "la-check--on": included }]}>{included && <CheckIcon $size="xs" />}</Span>
                    <ValueLabel facetKey={facet.key} value={value} />
                  </ClickableDiv>
                  <ActionIcon
                    $onClick={() => session.toggleFacet(facet.key, value, "exclude")}
                    $tooltip={excluded ? "Show it again" : "Leave it out"}
                    $className="la-facet-exclude"
                  >
                    <RemoveCircleOutlineIcon />
                  </ActionIcon>
                  <Span $className="la-facet-count">{count.toLocaleString()}</Span>
                </Div>
              );
            })}
            {facet.values.length > shownAtFirst && (
              <ClickableDiv $className="la-facet-more" $onClick={() => setAll(!all)}>
                {all ? "Show less" : `Show all ${facet.values.length}`}
              </ClickableDiv>
            )}
          </Div>
        )}
      </Div>
    );
  },
);

const ValueLabel = observer(({ facetKey, value }: { readonly facetKey: FacetKey; readonly value: string }) => {
  const clusterContexts = useInject(clustersInjectable)();

  if (facetKey === "cluster") {
    return (
      <>
        <ClusterDot clusterId={value} />
        <Span $className="la-facet-value">{clusterContexts.nameOf(value)}</Span>
      </>
    );
  }

  if (facetKey === "level") {
    return (
      <>
        <Span $className={["la-level-dot", `la-level-dot--${value}`]} />
        <Span $className="la-facet-value">{value}</Span>
      </>
    );
  }

  return (
    <Span $className="la-facet-value" $tooltip={value}>
      {value === "" ? "(empty)" : value}
    </Span>
  );
});
