// Fast drop-in replacement for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
//
// Semantics are exactly csv-reader's broken-row policy:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next undoubled quote; "" inside it is one
//     quote, and each CRLF or lone CR inside it is read as LF; whatever follows the closing
//     quote up to the next comma or line break is appended as it stands (quote_junk when
//     anything was appended); a quote that never closes is a literal character and the rest
//     of the field is re-read as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is literal; fields are never trimmed or converted;
//   - columns is the first record when header is true, else null; every row is padded with
//     "" (short_row, with fields: its count) or cut (long_row, with extra: the cut fields)
//     to the first record's width;
//   - errors are {code, line, row} in the order met; line is the 1-based line the record
//     starts on (every LF, CRLF and lone CR inside quotes counted), row is the record's
//     index in rows, null for the header.
//
// Speed comes from never walking the text character by character in JS: the positions of
// the next comma, LF, CR and quote are tracked as monotonically advancing indexOf cursors
// (each cursor's total scanning is linear over the whole parse, and the rewind after an
// unterminated quote is the only place they are rebuilt). Fields are cut out with slice(),
// and only fields that actually contain stray CRs, doubled quotes or CRs inside quotes are
// assembled from parts. Field readers report through shared variables instead of
// allocating a result object per field.

const COMMA_END = 0;
const BREAK_END = 1;
const TEXT_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Monotonic cursors: index of the next occurrence of each special character at or after
  // the last refresh point, or -1 when there is none left in the text.
  let cComma = text.indexOf(',', pos);
  let cLF = text.indexOf('\n', pos);
  let cCR = text.indexOf('\r', pos);
  let cQuote = text.indexOf('"', pos);

  let recordLine = 1;
  let recordRow = null;

  // The field just read, reported by readUnquoted / readQuoted.
  let fValue = '';
  let fEnded = TEXT_END;
  let fAdded = 0;

  // Reads unquoted characters up to the next comma or line break, dropping lone CRs
  // (stray_cr). `prefix` is null for a plain field, or the already-read value the text is
  // appended to (after a closing quote, or the literal quote of an unterminated field).
  // Sets fValue, fEnded and fAdded (characters this call kept, not counting the prefix).
  function readUnquoted(prefix) {
    let parts = prefix === null ? null : [prefix];
    let segStart = pos;
    let added = 0;
    for (;;) {
      if (cComma !== -1 && cComma < pos) cComma = text.indexOf(',', pos);
      if (cLF !== -1 && cLF < pos) cLF = text.indexOf('\n', pos);
      if (cCR !== -1 && cCR < pos) cCR = text.indexOf('\r', pos);
      let end = n;
      let ended = TEXT_END;
      let adv = 0;
      if (cComma !== -1 && cComma < end) { end = cComma; ended = COMMA_END; adv = 1; }
      if (cLF !== -1 && cLF < end) { end = cLF; ended = BREAK_END; adv = 1; }
      if (cCR !== -1 && cCR < end) {
        if (text.charCodeAt(cCR + 1) === 10) {
          // CRLF ends the field; the CR is not part of it.
          end = cCR; ended = BREAK_END; adv = 2;
        } else {
          // Lone CR before the field's end: drop it and keep reading the same field.
          if (parts === null) parts = [];
          if (cCR > segStart) {
            parts.push(text.slice(segStart, cCR));
            added += cCR - segStart;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          pos = cCR + 1;
          segStart = pos;
          continue;
        }
      }
      if (parts === null) {
        fValue = text.slice(segStart, end);
        added = end - segStart;
      } else {
        if (end > segStart) {
          parts.push(text.slice(segStart, end));
          added += end - segStart;
        }
        fValue = parts.join('');
      }
      fAdded = added;
      fEnded = ended;
      pos = end + adv;
      if (ended === BREAK_END) line += 1;
      return;
    }
  }

  // Reads a field whose opening quote is at pos. Sets fValue and fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let parts = null;
    let value = '';
    let closed = false;
    while (pos < n) {
      if (cQuote !== -1 && cQuote < pos) cQuote = text.indexOf('"', pos);
      if (cCR !== -1 && cCR < pos) cCR = text.indexOf('\r', pos);
      if (cLF !== -1 && cLF < pos) cLF = text.indexOf('\n', pos);
      let e = n;
      let kind = 0; // 1 = quote, 2 = CR, 3 = LF
      if (cQuote !== -1 && cQuote < e) { e = cQuote; kind = 1; }
      if (cCR !== -1 && cCR < e) { e = cCR; kind = 2; }
      if (cLF !== -1 && cLF < e) { e = cLF; kind = 3; }
      if (kind === 0) { pos = n; break; }
      if (kind === 3) {
        // An LF inside quotes is part of the value: leave the segment open across it.
        line += 1;
        pos = e + 1;
        continue;
      }
      if (kind === 2) {
        // CRLF or a lone CR inside quotes is read as one LF.
        if (parts === null) parts = [];
        if (e > segStart) parts.push(text.slice(segStart, e));
        parts.push('\n');
        line += 1;
        pos = text.charCodeAt(e + 1) === 10 ? e + 2 : e + 1;
        segStart = pos;
        continue;
      }
      if (text.charCodeAt(e + 1) === 34) {
        // Doubled quote: one literal quote in the value.
        if (parts === null) parts = [];
        if (e > segStart) parts.push(text.slice(segStart, e));
        parts.push('"');
        pos = e + 2;
        segStart = pos;
        continue;
      }
      // The closing quote.
      if (parts === null) {
        value = text.slice(segStart, e);
      } else {
        if (e > segStart) parts.push(text.slice(segStart, e));
        value = parts.join('');
      }
      pos = e + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read
      // again as unquoted. This is the one rewind in the parser; rebuild the cursors.
      pos = open + 1;
      line = openLine;
      cComma = text.indexOf(',', pos);
      cLF = text.indexOf('\n', pos);
      cCR = text.indexOf('\r', pos);
      cQuote = text.indexOf('"', pos);
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    if (pos >= n) { fValue = value; fEnded = TEXT_END; return; }
    const c = text[pos];
    if (c === ',') { pos += 1; fValue = value; fEnded = COMMA_END; return; }
    if (c === '\n') { pos += 1; line += 1; fValue = value; fEnded = BREAK_END; return; }
    if (c === '\r' && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line += 1; fValue = value; fEnded = BREAK_END; return;
    }
    // Junk after the closing quote is appended as it stands.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const ch = text[pos];
      if (ch === '\n') { pos += 1; line += 1; }
      else if (ch === '\r' && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (text[pos] === '"') {
        readQuoted();
        quoted = true;
      } else {
        readUnquoted(null);
        quoted = false;
      }
      fields.push(fValue);
    } while (fEnded === COMMA_END);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
