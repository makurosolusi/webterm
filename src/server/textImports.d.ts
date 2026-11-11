// Bun text imports (`import x from './file.md' with { type: 'text' }`), embedded by `bun build --compile`.
declare module '*.md' {
  const text: string
  export default text
}
