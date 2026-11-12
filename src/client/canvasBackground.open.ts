// Opening the Canvas background setting (Settings › Appearance). Split from CanvasBackgroundSection so
// the workspace bar (start-up) does not pull the editor, which loads with the Settings panel.
import { openSettingsAt } from './settings.link'

/** Open Settings › Appearance on the Canvas background (its "This workspace" choice is right there). */
export function openWorkspaceCanvasBackground(): void {
  openSettingsAt('appearance', 'canvasBackground')
}
