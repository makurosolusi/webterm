// Header label of a node: its unique name first ("Mango"), then the label muted ("Mango · Agent
// Chat"). The name is the fixed identity; the label after it is the editable title (or kind label).

/** `name · label`; just the name when there is no label, just the label when the node has no name yet. */
export function NodeNameLabel({ name, label }: { name?: string; label: string }) {
  if (!name) return <>{label}</>
  return (
    <>
      <span className="node-name">{name}</span>
      {label && <span className="node-name__label"> · {label}</span>}
    </>
  )
}

/** Plain-text form of the same label, for tab strips, the side bar, tooltips and confirm texts. */
export const withNodeName = (name: string | undefined, label: string): string =>
  name ? (label ? `${name} · ${label}` : name) : label
