import './vscode/vscode-theme.css'
import './index.css'
import './styles.css'
import './vscode/register'
import { installCodicons } from './vscode/codicons'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installClientLogger } from './output/clientLogger'
import { bootView, SignedOut } from './appBoot'

// Harus terpasang sebelum `<vscode-icon>` pertama tersambung (ia membaca href-nya sekali).
installCodicons()
installClientLogger()

// A `/?token=` landing link becomes the session cookie first; signed out, App never mounts (appBoot.tsx).
void bootView().then((view) => createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {/* One provider so hover timing is shared: moving between neighbours opens the next tooltip at once. */}
    <TooltipProvider>
      {view === 'app' ? <App /> : <SignedOut />}
    </TooltipProvider>
  </ErrorBoundary>,
))
