// "This site is checking that you're human" banner over a browser node. The check is the person's to do; agents are
// paused on the server while it shows. "I'm done" sends `challengeDone`, which clears the flag and lets agents continue.
import { Button } from '@/components/ui/button'
import { CHALLENGE_BANNER } from '../shared/browser.challenge'
import type { BrowserChallenge } from '../shared/browser.challenge'

/** Shown only while the node's page is a human check; `onDone` sends `challengeDone`. */
export default function BrowserChallengeBanner({ challenge, onDone }: { challenge?: BrowserChallenge; onDone: () => void }) {
  if (!challenge) return null
  return (
    <div
      role="status"
      data-challenge={challenge.kind}
      className="nodrag absolute bottom-2 left-2 right-2 z-20 flex items-center justify-between gap-2 rounded px-2 py-1 text-xs bg-(--vscode-editorWidget-background) text-(--vscode-foreground) border border-(--vscode-editorWidget-border)"
    >
      <span>{CHALLENGE_BANNER.text}</span>
      <Button size="bui" aria-label={CHALLENGE_BANNER.doneLabel} onClick={onDone}>
        {CHALLENGE_BANNER.done}
      </Button>
    </div>
  )
}
