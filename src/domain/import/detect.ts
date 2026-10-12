import { isCamt053, parseCamt053 } from './camt053';
import { findMapping, parseCsv, readCsv, type MappingSpec } from './csv';
import { isOfx, parseOfx } from './ofx';
import { isSavingsFundCsv, parseSavingsFund } from './savingsFund';
import { isSpuerkeessStatement, parseSpuerkeess } from './spuerkeess';
import { ImportParseError, type ParseResult } from './types';
import { isWorldlineStatement, parseWorldline } from './worldline';

export type FileContent =
  | { kind: 'text'; name: string; text: string }
  | { kind: 'pdf'; name: string; lines: string[] };

export type Detection<M extends MappingSpec> =
  | { kind: 'parsed'; result: ParseResult; mapping?: M }
  /** CSV with no saved mapping: the UI asks the user to map the columns. */
  | { kind: 'needsMapping'; header: string[]; sample: string[][] };

/** Work out what a file is and parse it. */
export function detectAndParse<M extends MappingSpec>(file: FileContent, mappings: readonly M[], parseXml: (xml: string) => Document): Detection<M> {
  if (file.kind === 'pdf') {
    if (isWorldlineStatement(file.lines)) return { kind: 'parsed', result: parseWorldline(file.lines) };
    if (isSpuerkeessStatement(file.lines)) return { kind: 'parsed', result: parseSpuerkeess(file.lines) };
    throw new ImportParseError('unknownFormat');
  }
  const text = file.text;
  if (/\.(ofx|qfx)$/i.test(file.name) || isOfx(text)) {
    if (!isOfx(text)) throw new ImportParseError('unknownFormat');
    return { kind: 'parsed', result: parseOfx(text) };
  }
  if (/\.xml$/i.test(file.name) || /^\s*<\?xml|^\s*<Document/.test(text)) {
    if (!isCamt053(text)) throw new ImportParseError('unknownFormat');
    return { kind: 'parsed', result: parseCamt053(parseXml(text)) };
  }
  const table = readCsv(text);
  const header = table.find((r) => r.some((c) => c !== ''));
  if (!header || header.length < 2) throw new ImportParseError('unknownFormat');
  if (isSavingsFundCsv(header)) return { kind: 'parsed', result: parseSavingsFund(text) };
  const mapping = findMapping(header, mappings);
  if (!mapping) return { kind: 'needsMapping', header, sample: table.slice(1, 6) };
  return { kind: 'parsed', result: parseCsv(text, mapping), mapping };
}
