import { Span } from "@k8slens/element-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { clustersInjectable } from "../clusters.injectable";
import { hueOf } from "./hue";

/** The colour Lens tells the cluster apart by, or one derived from its id when the user turned that off. */
export const ClusterDot = observer(({ clusterId }: { readonly clusterId: string }) => {
  const clusterContexts = useInject(clustersInjectable)();

  return (
    <Span
      $className="la-dot"
      $style={{ background: clusterContexts.colorOf(clusterId) ?? `hsl(${hueOf(clusterId)} 65% 50%)` }}
      $tooltip={clusterContexts.nameOf(clusterId)}
    />
  );
});
