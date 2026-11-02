import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // VS Code input box: 25px, 4px radius, input-border at rest, focusBorder when focused.
        "h-[25px] w-full min-w-0 rounded-(--vscode-cornerRadius-small) border border-(--vscode-input-border) bg-(--vscode-input-background) px-1.5 py-0.5 text-[13px] text-(--vscode-input-foreground) outline-none file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-[13px] file:text-foreground placeholder:text-(--vscode-input-placeholderForeground) disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:border-(--vscode-focusBorder) focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
