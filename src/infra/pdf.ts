import { fragmentsToLines, type PdfPageText } from '../domain/import/pdfLines';

/** The part of the pdf.js API we use; both the browser and the Node build provide it. */
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; disableFontFace?: boolean; useSystemFonts?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
    }>;
    destroy(): Promise<void>;
  };
}

interface Item {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** Extract layout lines from a PDF. Text only: nothing is rendered or executed. */
export async function pdfToLines(pdfjs: PdfJsLike, data: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
  try {
    const doc = await task.promise;
    const pages: PdfPageText[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      const fragments = (content.items as Item[])
        .filter((it) => typeof it.str === 'string')
        .map((it) => ({ str: it.str, x: it.transform[4]!, y: it.transform[5]!, width: it.width, height: it.height }));
      pages.push({ fragments });
    }
    return fragmentsToLines(pages);
  } finally {
    await task.destroy();
  }
}
