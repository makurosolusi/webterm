// The desktop client's route table (URL contract in `./appRoute`). Both board paths render the SAME
// App element type, so moving between `/` and `/w/:id` keeps App (and every live terminal) mounted.
import { Navigate, Route, Routes } from 'react-router'
import App from './App'
import { AppRouteSync } from './appRoute'

/** Routes under whichever router the caller provides (`BrowserRouter` in main, `MemoryRouter` in tests). */
export default function AppRoutes(): React.JSX.Element {
  return (
    <>
      <AppRouteSync />
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/w/:workspaceId" element={<App />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
