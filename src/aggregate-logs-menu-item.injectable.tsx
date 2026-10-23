import { DropDownMenuItemRow } from "@k8slens/drop-down-menu-items";
import { SubjectIcon } from "@k8slens/icon";
import {
  getKubeResourceMenuItemInjectableBunch,
  type KubeResourceMenuTarget,
  kubeResourceMenuOrderNumbers,
} from "@k8slens/kube-resource-menu-contracts";
import { useInject } from "@k8slens/use-inject";
import { type SourceKind, sourceKinds } from "./model";
import { openAggregatorInjectable } from "./open-aggregator.injectable";

const AggregateLogs = ({ data }: { readonly data: KubeResourceMenuTarget }) => {
  const openAggregator = useInject(openAggregatorInjectable)();

  return (
    <DropDownMenuItemRow
      Icon={SubjectIcon}
      $onClick={() =>
        void openAggregator({
          clusterId: data.clusterId,
          kind: data.kind as SourceKind,
          namespace: data.namespace ?? "default",
          name: data.name,
        })
      }
    >
      Aggregate logs
    </DropDownMenuItemRow>
  );
};

export default getKubeResourceMenuItemInjectableBunch({
  id: "logs-aggregator-aggregate-logs-menu-item",
  orderNumber: kubeResourceMenuOrderNumbers.sectionEnd + 100,
  isVisible: (target) => (sourceKinds as readonly string[]).includes(target.kind) && target.namespace !== undefined,
  Component: AggregateLogs,
});
