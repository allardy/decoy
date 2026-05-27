// session-guide.md is inlined into the main bundle as a string via Vite's ?raw suffix,
// so the packaged app needs no runtime file read for the agent reading guide.
declare module '*.md?raw' {
  const content: string

  export default content
}
