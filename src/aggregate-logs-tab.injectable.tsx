import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import { getTabKind, getTabKindInjectableBunch } from "@k8slens/tab-contracts";
import type { Scope } from "./model";
import { tabScopesBunch } from "./session.injectable";
import { AggregatorTab, AggregatorTitle } from "./view/aggregator-tab";

/**
 * A main-view tab rather than a dock tab: the dock belongs to one cluster, and an aggregation
 * may span several.
 */
export const aggregateLogsTabKind = getTabKind<Scope>()("aggregate-logs");

export default getTabKindInjectableBunch({
  tabHostKind: mainViewTabHostKind,
  kind: aggregateLogsTabKind,
  Component: AggregatorTab,
  Title: AggregatorTitle,

  onTabCreate: {
    instantiate: (di) => {
      const getTabScopes = di.inject(tabScopesBunch.persistable);

      return () =>
        async ({ tabId, input }) => {
          (await getTabScopes()).set(tabId, input);
        };
    },
  },
});
