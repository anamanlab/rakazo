/**
 * Vite serves a file imported with `?raw` as its text. The edge package has no
 * Vite runtime, but the test runner does, so the import is typed here.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
