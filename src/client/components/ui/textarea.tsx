import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-[25px] w-full rounded-(--vscode-cornerRadius-small) border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 py-1 text-[13px] text-(--vscode-input-foreground) outline-none placeholder:text-(--vscode-input-placeholderForeground) focus-visible:border-(--vscode-focusBorder) focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
