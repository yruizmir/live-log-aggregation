import { getCommandInjectableBunch } from "@k8slens/command-palette-contracts";
import { openAggregatorInjectable } from "./open-aggregator.injectable";

export default getCommandInjectableBunch({
  id: "logs-aggregator.open",
  title: "Live Log Aggregation: Open",
  action: {
    instantiate: (di) => {
      const openAggregator = di.inject(openAggregatorInjectable)();

      return () => () => openAggregator();
    },
  },
});
