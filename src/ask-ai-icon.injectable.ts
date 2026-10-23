import { effectiveAiToolIconInjectionToken } from "@k8slens/ai-tools-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { computed, type IComputedValue, observable, runInAction } from "mobx";
import type React from "react";

type ToolIcon = React.ComponentType<Record<string, unknown>>;

/**
 * The logo of the AI tool Ask AI runs, as Lens's own Ask AI buttons show it; `undefined` until
 * Lens has said which tool that is.
 */
export const askAiIconInjectable = getInjectable2({
  id: "logs-aggregator-ask-ai-icon",
  consumptions: [effectiveAiToolIconInjectionToken],

  instantiate: (di) => {
    const effectiveIcon = di.inject(effectiveAiToolIconInjectionToken)();
    const icon = observable.box<IComputedValue<ToolIcon> | undefined>(undefined, { deep: false });

    void effectiveIcon.then((loaded) => runInAction(() => icon.set(loaded as unknown as IComputedValue<ToolIcon>)));

    const value = computed(() => icon.get()?.get());

    return () => value;
  },
});
