/**
 * jsdom shims for vscode-elements.
 *
 * The components use `ElementInternals` form APIs that jsdom implements only
 * partially (`setFormValue` and `setValidity` are missing). Without these stubs
 * every button/textfield update rejects asynchronously, which Vitest reports as
 * an unhandled error. Patching the prototype keeps the assertions honest instead
 * of swallowing the rejection.
 */
type PatchableInternals = ElementInternals & {
  setFormValue?: (value: FormData | string | null) => void
  setValidity?: (
    flags?: ValidityStateFlags,
    message?: string,
    anchor?: HTMLElement,
  ) => void
}

if (typeof ElementInternals !== 'undefined') {
  const proto = ElementInternals.prototype as PatchableInternals
  if (typeof proto.setFormValue !== 'function') {
    Object.defineProperty(proto, 'setFormValue', { value: () => {}, configurable: true })
  }
  if (typeof proto.setValidity !== 'function') {
    Object.defineProperty(proto, 'setValidity', { value: () => {}, configurable: true })
  }
}
