import { allClusterRecordsReactiveInjectionToken, type ClusterRecord } from "@k8slens/cluster-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { computed, type IComputedValue, observable, runInAction } from "mobx";

/** The clusters Lens knows, with their names and colours, followed as they come, go and get renamed. */
export const clustersInjectable = getInjectable2({
  id: "logs-aggregator-clusters",
  consumptions: [allClusterRecordsReactiveInjectionToken],

  instantiate: (di) => {
    const allClusterRecords = di.inject(allClusterRecordsReactiveInjectionToken)();
    const records = observable.box<IComputedValue<ClusterRecord[]> | undefined>(undefined, { deep: false });
    const clusters = computed((): readonly ClusterRecord[] => records.get()?.get() ?? []);

    void allClusterRecords.then((loaded) => runInAction(() => records.set(loaded)));

    const clusterById = (clusterId: string) => clusters.get().find((cluster) => cluster.id === clusterId);

    const value = {
      clusters,
      nameOf: (clusterId: string) => clusterById(clusterId)?.name.get() || clusterId,
      colorOf: (clusterId: string) => clusterById(clusterId)?.color.get() || undefined,
      isConnected: (clusterId: string) => clusterById(clusterId)?.isConnected.get() ?? false,
    };

    return () => value;
  },
});
