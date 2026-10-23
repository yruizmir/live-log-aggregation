import { navigateToKubeResourceDetailsInjectionToken } from "@k8slens/details-panel-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import {
  appsV1,
  batchV1,
  coreV1,
  cronJobKind,
  daemonSetKind,
  deploymentKind,
  getKubeResourceKind,
  jobKind,
  type KubeResourceKind,
  type KubernetesApiVersion,
  nodeKind,
  persistentVolumeClaimKind,
  podKind,
  replicaSetKind,
  serviceKind,
  statefulSetKind,
} from "@k8slens/kubernetes-contracts";
import { navigateToPodsInjectionToken } from "@k8slens/kubernetes-resources-contracts";
import { activeTabClusterIdInjectionToken } from "@k8slens/main-view-contracts";
import { isNavigationSupersededError } from "@k8slens/navigation-contracts";
import { showErrorNotificationInjectionToken } from "@k8slens/notifications-contracts";
import { clustersInjectable } from "./clusters.injectable";
import type { EventRef, ResourceRef } from "./model";

/** Lens declares no kind for events, so the extension names it to open an event's details. */
export const eventKind = getKubeResourceKind<{
  v1: {
    kind: "Event";
    metadata: { name: string; namespace: string };
    reason?: string;
    message?: string;
  };
}>("Event");

const detailsOf: Record<string, readonly [KubeResourceKind, KubernetesApiVersion]> = {
  Pod: [podKind, coreV1],
  Deployment: [deploymentKind, appsV1],
  StatefulSet: [statefulSetKind, appsV1],
  DaemonSet: [daemonSetKind, appsV1],
  ReplicaSet: [replicaSetKind, appsV1],
  Job: [jobKind, batchV1],
  CronJob: [cronJobKind, batchV1],
  Node: [nodeKind, coreV1],
  PersistentVolumeClaim: [persistentVolumeClaimKind, coreV1],
  Service: [serviceKind, coreV1],
};

const clusterScoped = new Set(["Node"]);

/** Long enough for Lens to load a cluster's views the first time, short enough to not leave the click hanging. */
const navigationTimeoutMs = 15_000;

/** Takes the user to what an alarm is about: the resource, or the event that raised it. */
export const goToInjectable = getInjectable2({
  id: "logs-aggregator-go-to",
  consumptions: [
    navigateToKubeResourceDetailsInjectionToken,
    navigateToPodsInjectionToken,
    showErrorNotificationInjectionToken,
    activeTabClusterIdInjectionToken,
  ],

  instantiate: (di) => {
    const navigateToDetails = di.inject(navigateToKubeResourceDetailsInjectionToken)();
    const navigateToPods = di.inject(navigateToPodsInjectionToken)();
    const showError = di.inject(showErrorNotificationInjectionToken)();
    const activeTabClusterId = di.inject(activeTabClusterIdInjectionToken)();
    const clusters = di.inject(clustersInjectable)();

    const quietly = async (navigation: () => Promise<unknown>, clusterId: string, what: string) => {
      try {
        const landed = await Promise.race([navigation().then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), navigationTimeoutMs))]);

        if (!landed) {
          showError(new Error(`Lens did not open ${what} of ${clusters.nameOf(clusterId)}: it is not answering for that cluster.`));

          return false;
        }

        // Some clusters, such as ones another extension discovers, take the navigation without showing
        // anything, or never finish it: say so rather than leave the click looking ignored.
        if ((await activeTabClusterId()) !== clusterId) {
          showError(new Error(`Lens did not open ${what} of ${clusters.nameOf(clusterId)}: it cannot show that cluster's resources from here.`));

          return false;
        }

        return true;
      } catch (error) {
        if (!isNavigationSupersededError(error)) {
          showError(error as Error);
        }

        return false;
      }
    };

    const resource = async (ref: ResourceRef) => {
      const details = detailsOf[ref.kind];

      if (!details) {
        // A kind Lens has no details for here: the pods of its namespace are the nearest place.
        return quietly(() => navigateToPods({ clusterId: ref.clusterId, namespaces: [ref.namespace] }), ref.clusterId, `the pods of ${ref.namespace}`);
      }

      const [kind, apiVersion] = details;

      return quietly(() =>
        navigateToDetails({
          clusterId: ref.clusterId,
          kind,
          apiVersion,
          ref: clusterScoped.has(ref.kind) ? { name: ref.name } : { name: ref.name, namespace: ref.namespace },
        }),
        ref.clusterId,
        `${ref.kind} ${ref.namespace}/${ref.name}`,
      );
    };

    return () => ({
      resource,

      event: (clusterId: string, event: EventRef) =>
        quietly(() =>
          navigateToDetails({
            clusterId,
            kind: eventKind,
            apiVersion: coreV1,
            ref: { name: event.name, namespace: event.namespace },
          }),
          clusterId,
          `the event ${event.name}`,
        ),

      /** Into the cluster, where Ask AI opens its conversation, without leaving a dead end. */
      cluster: (clusterId: string, namespace?: string) =>
        quietly(() => navigateToPods({ clusterId, ...(namespace ? { namespaces: [namespace] } : {}) }), clusterId, "the pods"),
    });
  },
});
