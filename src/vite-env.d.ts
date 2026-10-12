/// <reference types="vite/client" />

/** Build time (UTC, "2026-10-11 14:32"), shown in Settings. */
declare const __APP_BUILT__: string;

/** pdf.js worker module, imported directly to read PDFs on the main thread. */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
