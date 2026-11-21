// All user-facing text of the screenshot annotator (one place, English).
import type { Tool } from '../shot.types'

/** Command id and palette label; the Dock button and the shortcut both run this one command. */
export const SCREENSHOT_COMMAND_ID = 'canvas.screenshot'
export const SCREENSHOT_COMMAND_LABEL = 'Canvas: Take Screenshot'
/** Notice channel: one visible screenshot notice at a time. */
export const SCREENSHOT_NOTICE_KEY = 'webterm-screenshot'

export const TOOL_LABEL: Record<Tool, string> = {
  pen: 'Pen', line: 'Line', arrow: 'Arrow', rect: 'Rectangle', marker: 'Marker', text: 'Text',
}

export const SHOT_TEXT = {
  dialog: 'Screenshot: select an area to capture',
  capturing: 'Capturing the page…',
  rail: 'Annotation tools',
  actions: 'Screenshot actions',
  selectionHint: 'Drag to select an area, or press Enter to select the whole window',
  selectionLabel: (size: string): string => `Selection ${size}. Arrow keys move it, Shift plus arrow keys resize it.`,
  color: 'Color',
  colorPicker: 'Color and size',
  stroke: 'Stroke width',
  textSize: 'Text size',
  undo: 'Undo', redo: 'Redo', nothingToUndo: 'Nothing to undo', nothingToRedo: 'Nothing to redo',
  copy: 'Copy to clipboard', save: 'Save as PNG', close: 'Close',
  textInput: 'Annotation text. Enter adds it, Shift+Enter starts a new line, Escape cancels.',
  widths: ['Thin', 'Medium', 'Thick'],
  sizes: ['Small', 'Medium', 'Large'],
  busy: { copying: 'Copying…', saving: 'Saving…' },
  copied: 'Copied to clipboard',
  saved: (name: string): string => `Saved ${name}`,
  saveAction: 'Save as PNG',
  retryAction: 'Try again',
  errors: {
    page_too_large: { title: 'Page too large to capture', message: 'Too many elements are on screen. Close or minimize some nodes and try again.' },
    failed: { title: 'Could not capture the page', message: 'The page could not be rendered to an image.' },
    busy: { title: 'A capture is already running', message: 'Wait for it to finish, then try again.' },
    copyDenied: { title: 'Clipboard access was denied', message: 'The browser did not allow copying an image. Save it as a file instead.' },
    copyUnsupported: { title: 'This browser cannot copy images', message: 'Save the screenshot as a file instead.' },
    copyFailed: { title: 'Could not copy the screenshot', message: 'Copying failed. Save it as a file instead.' },
    saveFailed: { title: 'Could not save the screenshot', message: 'The image could not be encoded or downloaded.' },
  },
} as const
