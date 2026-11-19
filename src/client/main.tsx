import './vscode/vscode-theme.css'
import './index.css'
import './styles.css'
import './fonts/sticky.font.css'
import './vscode/register'
import { installCodicons } from './vscode/codicons'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import AppRoutes from './App.routes'
import { ErrorBoundary } from './ErrorBoundary'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installClientLogger } from './output/clientLogger'
import { bootView, SignedOut } from './appBoot'

// Harus terpasang sebelum `<vscode-icon>` pertama tersambung (ia membaca href-nya sekali).
installCodicons()
installClientLogger()

// A `/?token=` landing link becomes the session cookie first; signed out, App never mounts (appBoot.tsx).
// The router mounts only after that, so it never sees the token URL `bootView` rewrites with replaceState.
void bootView().then((view) => createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {/* One provider so hover timing is shared: moving between neighbours opens the next tooltip at once. */}
    <TooltipProvider>
      {view === 'app' ? <BrowserRouter><AppRoutes /></BrowserRouter> : <SignedOut />}
    </TooltipProvider>
  </ErrorBoundary>,
))
