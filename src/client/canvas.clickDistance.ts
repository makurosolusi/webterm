// Pointer travel (px) between press and release that still counts as a click on a node's body.
//
// React Flow installs a d3-drag on every node. d3-drag swallows the `click` that follows ANY movement larger than its
// `clickDistance` (React Flow's `nodeClickDistance`, default 0) unless the target sits inside a `nodrag` element, so a 1px
// hand wobble killed clicks on buttons and tabs. 4px is below the ~5-6px a deliberate drag needs (Chrome/Windows drag
// thresholds are 4-6px) and does not touch dragging: node drag start is `nodeDragThreshold`, a separate prop, and
// selection happens on press. It applies to EVERY node (terminal, agent, editor, browser, ...): a wobble of up to 4px now
// stays a click there too; a longer movement is still a drag and still swallows the click, as before.
export const NODE_CLICK_DISTANCE = 4
