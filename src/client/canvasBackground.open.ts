// Opening the Canvas background settings section. Split from CanvasBackgroundSection so the workspace bar
// (start-up) does not pull the section editor, which loads with the Settings panel.
import { openSettingsSection } from './settings.link'

/** Settings section id; the `:workspace` suffix opens it scoped to the active workspace. */
export const CANVAS_BG_SECTION = 'background'
export const CANVAS_BG_WORKSPACE_SECTION = `${CANVAS_BG_SECTION}:workspace`

/** Open Settings on the Canvas background section, scoped to the active workspace. */
export function openWorkspaceCanvasBackground(): void {
  openSettingsSection(CANVAS_BG_WORKSPACE_SECTION)
}
