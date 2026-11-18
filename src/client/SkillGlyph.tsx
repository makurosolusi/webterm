/** The skill's round glyph (book icon in an accent ring): the token of a collapsed skill node and the avatar of an expanded one. */
export function SkillGlyph({ className = '' }: { className?: string }) {
  return <span className={`skill-glyph ${className}`} aria-hidden="true"><span className="codicon codicon-book" /></span>
}
