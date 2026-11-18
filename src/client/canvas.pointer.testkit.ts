// Real-browser event order for one physical press, for tests that run a real React Flow (d3-drag) in jsdom.
import { fireEvent } from '@testing-library/react'

/** A mouse event as the browser makes it: d3-drag reads `event.view` (the window it listens on), which jsdom's constructor refuses to take. */
export function mouse(type: 'mousedown' | 'mousemove' | 'mouseup' | 'click', target: Element | Window, x: number) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10 })
  Object.defineProperty(ev, 'view', { value: window })
  fireEvent(target, ev)
}

/** One physical click with `wobble` px of pointer travel (in `steps` moves) between press and release, in the order a browser fires them. */
export function press(el: HTMLElement, wobble: number, steps = 1) {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
  mouse('mousedown', el, 10)
  for (let i = 1; i <= steps; i++) {
    const x = 10 + Math.round((wobble * i) / steps)
    fireEvent.pointerMove(window, { clientX: x, clientY: 10, pointerId: 1 })
    mouse('mousemove', window, x)
  }
  fireEvent.pointerUp(window, { clientX: 10 + wobble, clientY: 10, pointerId: 1 })
  mouse('mouseup', window, 10 + wobble)
  mouse('click', el, 10 + wobble)
}
