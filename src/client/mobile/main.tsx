// Entry of the /m PWA (src/client/m/index.html). Kept apart from the desktop bundle on purpose: no
// canvas, xterm or Monaco on a phone.
import { createRoot } from 'react-dom/client'
import { MobileApp } from './MobileApp'
import { SW_SCOPE, SW_URL } from './mobile.push'
import { adoptToken } from './mobile.token'
import './mobile.css'

adoptToken()
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch((err: unknown) => console.warn('[m] service worker registration failed', err))
}
createRoot(document.getElementById('root')!).render(<MobileApp />)
