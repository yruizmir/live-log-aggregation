import { Button, type ButtonProps } from "@k8slens/element-components";

/** An icon-only control: a glyph inside a button, with a tooltip saying what it does. */
export const ActionIcon = ({ $className, ...rest }: ButtonProps & { readonly $tooltip: string }) => (
  <Button type="button" $className={["la-icon-button", $className]} {...rest} />
);
