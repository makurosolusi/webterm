import './vscode/vscode-theme.css'
import './index.css'
import './styles.css'
import './vscode/register'
import { installCodicons } from './vscode/codicons'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'

// Harus terpasang sebelum `<vscode-icon>` pertama tersambung (ia membaca href-nya sekali).
installCodicons()

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
