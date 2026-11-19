import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// Callout block. `caution` is the muted warning tone (security notes); `destructive` is for real errors only.
const alertVariants = cva(
  "relative grid w-full grid-cols-[auto_1fr] items-start gap-x-2 gap-y-0.5 rounded-(--vscode-cornerRadius-small) border px-3 py-2 text-[length:var(--bui-font-sm,12px)] leading-4 [&>svg]:mt-px [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-(--vscode-widget-border,var(--border)) bg-(--vscode-editorWidget-background,transparent) text-foreground",
        caution: "border-(--vscode-editorWarning-foreground) bg-(--vscode-inputValidation-warningBackground,transparent) text-foreground [&>svg]:text-(--vscode-editorWarning-foreground)",
        destructive: "border-(--vscode-errorForeground) bg-(--vscode-inputValidation-errorBackground,transparent) text-foreground [&>svg]:text-(--vscode-errorForeground)",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role={variant === "destructive" ? "alert" : "note"} className={cn(alertVariants({ variant }), className)} {...props} />
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("col-start-2 font-semibold", className)} {...props} />
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("col-start-2 text-(--vscode-descriptionForeground)", className)} {...props} />
}

export { Alert, AlertTitle, AlertDescription }
