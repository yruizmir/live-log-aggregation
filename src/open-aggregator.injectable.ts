import { getInjectable2 } from "@k8slens/injectable";
import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import { focusTabInjectionToken, openTabInjectionToken, tabIsOpenInjectionToken } from "@k8slens/tab-contracts";
import { aggregateLogsTabKind } from "./aggregate-logs-tab.injectable";
import { emptyScope, type LogSource, type Scope, sourceKey } from "./model";

/**
 * Opens a tab on one source or on one cluster, or brings back the one already open on it; with
 * neither, opens an empty one.
 */
export const openAggregatorInjectable = getInjectable2({
  id: "logs-aggregator-open",
  consumptions: [openTabInjectionToken, focusTabInjectionToken, tabIsOpenInjectionToken],

  instantiate: (di) => {
    const openTab = di.inject(openTabInjectionToken.for(mainViewTabHostKind).for(aggregateLogsTabKind).for(di.scopeIds))();
    const focusTab = di.inject(focusTabInjectionToken.for(mainViewTabHostKind).for(aggregateLogsTabKind).for(di.scopeIds))();
    const isOpen = di.inject(tabIsOpenInjectionToken.for(mainViewTabHostKind).for(aggregateLogsTabKind).for(di.scopeIds))();

    const openOrFocus = async (tabId: string, input: Scope) => {
      if (await isOpen({ tabId })) {
        await focusTab({ tabId });
      } else {
        await openTab({ tabId, input });
      }
    };

    return () =>
      async (target?: LogSource | { readonly clusterId: string }) => {
        if (!target) {
          await openTab({ tabId: `new-${Date.now()}`, input: emptyScope });
        } else if ("kind" in target) {
          await openOrFocus(sourceKey(target), { clusterIds: [target.clusterId], sources: [target] });
        } else {
          await openOrFocus(`cluster:${target.clusterId}`, { clusterIds: [target.clusterId], sources: [] });
        }
      };
  },
});
