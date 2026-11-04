// In-app prompt asking for notification permission. `Notification.requestPermission()` needs a
// user gesture in Firefox/Safari (and Chrome quiet-blocks gestureless requests), so the first
// agent event shows this toast and the "Allow" click makes the real request. Mounted on its own
// root so it works no matter which panel is open.
import { createRoot } from 'react-dom/client'
import { VscodeNotification } from './components/vscode/vscodeNotification'

export function showPermissionPrompt(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = () => {
    root.unmount()
    host.remove()
  }
  root.render(
    <VscodeNotification
      id="webterm-notify-permission"
      severity="info"
      sticky
      title="An agent needs your attention"
      message="Allow desktop notifications so webterm can tell you when agents finish or need input while this tab is in the background."
      actions={[
        { label: 'Allow', onClick: () => { void Notification.requestPermission().finally(close) } },
        { label: 'Not now', onClick: close },
      ]}
      onClose={close}
    />,
  )
}
