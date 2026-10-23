import { Icon } from "@k8slens/icon";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import type React from "react";
import { askAiIconInjectable } from "../ask-ai-icon.injectable";

type IconProps = Omit<React.ComponentProps<typeof Icon>, "material" | "svg">;

/** Ask AI's icon: the logo of the tool it runs, or Lens's sparkles until that is known. */
export const AskAiIcon = observer((props: IconProps) => {
  const ToolIcon = useInject(askAiIconInjectable)().get() as React.ComponentType<IconProps> | undefined;

  return ToolIcon ? <ToolIcon {...props} /> : <Icon material="auto_awesome" {...props} />;
});
