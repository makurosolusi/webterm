// The calm security callout (warning tone, never the error red) with a folded "Learn more", and the folded
// "How to get a cookie file" help. Both use Collapsible so keyboard, aria-expanded and focus come for free.
import { ChevronRight, ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CI } from './cookieImport.text'

const CHEVRON = 'transition-transform motion-reduce:transition-none'

export function CookieSecurityAlert(): React.JSX.Element {
  return (
    <Alert variant="caution">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>{CI.security.title}</AlertTitle>
      <AlertDescription>
        {CI.security.body}
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="link" size="bui" className="px-0 [&[data-state=open]>svg]:rotate-90">
              <ChevronRight aria-hidden="true" className={CHEVRON} />{CI.security.more}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-1">
            <p className="m-0">{CI.security.detail}</p>
            <p className="m-0">{CI.security.safest}</p>
          </CollapsibleContent>
        </Collapsible>
      </AlertDescription>
    </Alert>
  )
}

export function CookieHelp(): React.JSX.Element {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="bui" className="-ml-2 [&[data-state=open]>svg]:rotate-90">
          <ChevronRight aria-hidden="true" className={CHEVRON} />{CI.help.summary}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 pl-4 text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">
          {CI.help.steps.map((s) => <li key={s.title}><strong className="font-semibold text-foreground">{s.title}.</strong> {s.body}</li>)}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
