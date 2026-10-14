import type { ElementType, ReactNode } from "react";

/**
 * RESPONSIVE LABEL — text at wide widths, an icon on narrow ones.
 *
 * Drop it inside any button/link in place of the bare label. Below the
 * `collapseBelow` breakpoint only the icon shows; the text moves to
 * `sr-only` so the control keeps its accessible name. Put the same text in
 * the parent's `title` (use `labelProps(text)` for that) for the tooltip.
 */

type Breakpoint = "sm" | "md" | "lg" | "xl";

const SHOW_TEXT: Record<Breakpoint, string> = {
  sm: "hidden sm:inline",
  md: "hidden md:inline",
  lg: "hidden lg:inline",
  xl: "hidden xl:inline",
};

const HIDE_ICON: Record<Breakpoint, string> = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden",
  xl: "xl:hidden",
};

export default function ResponsiveLabel({
  icon: Icon,
  children,
  collapseBelow = "sm",
  iconClassName = "h-4 w-4 shrink-0",
}: {
  /** Any lucide-react (or compatible) icon component. */
  icon: ElementType;
  /** The text label. Must be a string-like node for the accessible name. */
  children: ReactNode;
  /** Text shows at this breakpoint and up. */
  collapseBelow?: Breakpoint;
  iconClassName?: string;
}) {
  return (
    <>
      <Icon
        className={`${iconClassName} ${HIDE_ICON[collapseBelow]}`}
        aria-hidden="true"
      />
      {/* Visible text at wide widths... */}
      <span className={SHOW_TEXT[collapseBelow]}>{children}</span>
      {/* ...and still announced on narrow ones. */}
      <span className={`sr-only ${HIDE_ICON[collapseBelow]}`}>{children}</span>
    </>
  );
}

/** Spread on the parent control: tooltip + accessible name. */
export function labelProps(text: string) {
  return { title: text, "aria-label": text } as const;
}
