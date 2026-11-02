import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// VS Code button metrics (button.css): min-height 24px, 4px/11px padding, 2px radius, 13px,
// default cursor, no shadow, 1px focusBorder outline offset 2px, 40% opacity when disabled.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-default items-center justify-center gap-1 rounded-[2px] border border-transparent text-[13px] leading-4 font-normal whitespace-nowrap outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-(--vscode-focusBorder) disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-(--vscode-button-background) text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground)",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline:
          "border-(--vscode-input-border) bg-transparent text-foreground hover:bg-(--vscode-toolbar-hoverBackground)",
        secondary:
          "bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground)",
        ghost: "text-foreground hover:bg-(--vscode-toolbar-hoverBackground)",
        link: "text-(--vscode-textLink-foreground) hover:text-(--vscode-textLink-activeForeground) hover:underline",
      },
      size: {
        default: "min-h-6 px-[11px] py-1 has-[>svg]:px-2",
        xs: "min-h-5 gap-1 px-2 py-0.5 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-6 gap-1 px-2 py-1 has-[>svg]:px-1.5",
        lg: "min-h-7 px-[14px] py-1.5 has-[>svg]:px-3",
        icon: "size-6 rounded-[5px]",
        "icon-xs": "size-5 rounded-[5px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-[22px] rounded-[5px]",
        "icon-lg": "size-7 rounded-[5px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
