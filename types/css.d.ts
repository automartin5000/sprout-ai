// Allow TypeScript to accept CSS side-effect imports (e.g. `import './foo.css'`)
declare module '*.css' {
  const stylesheet: string;
  export default stylesheet;
}
