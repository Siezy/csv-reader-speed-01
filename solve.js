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
// Method: a single left-to-right pass whose field readers scan with tight charCodeAt
// loops to the next special character (comma / LF / CR outside quotes; quote / LF / CR
// inside), cut fields out with slice(), and assemble a field from parts only when it
// actually contains a stray CR, a doubled quote or a CR inside quotes. Field readers
// report through shared variables instead of allocating a result object per field.
// (Scanning core proposed by Hermes, the trio's second implementer, and adopted after it
// beat the previous indexOf-cursor design by ~6-7% in interleaved A/B benchmarks on two
// machines, with identical output on every differential test.)
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

  let recordLine = 1;
  let recordRow = null;
  let fValue = '';
  let fEnded = TEXT_END;
  let fAdded = 0;

  function readUnquoted(prefix) {
    let parts = prefix === null ? null : [prefix];
    let segStart = pos;
    let added = 0;
    for (;;) {
      let i = pos;
      let c = 0;
      while (i < n) {
        c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        i++;
      }
      let end = i;
      let ended = TEXT_END;
      let adv = 0;
      if (i < n) {
        if (c === 44) { ended = COMMA_END; adv = 1; }
        else if (c === 10) { ended = BREAK_END; adv = 1; }
        else { // CR
          if (text.charCodeAt(i + 1) === 10) { ended = BREAK_END; adv = 2; }
          else {
            if (parts === null) parts = [];
            if (i > segStart) {
              parts.push(text.slice(segStart, i));
              added += i - segStart;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            pos = i + 1;
            segStart = pos;
            continue;
          }
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

  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let parts = null;
    let value = '';
    let closed = false;
    while (pos < n) {
      let i = pos;
      let c = 0;
      while (i < n) {
        c = text.charCodeAt(i);
        if (c === 34 || c === 10 || c === 13) break;
        i++;
      }
      if (i >= n) { pos = n; break; }
      if (c === 10) { line += 1; pos = i + 1; continue; }
      if (c === 13) {
        if (parts === null) parts = [];
        if (i > segStart) parts.push(text.slice(segStart, i));
        parts.push('\n');
        line += 1;
        pos = text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
        segStart = pos;
        continue;
      }
      // quote
      if (text.charCodeAt(i + 1) === 34) {
        if (parts === null) parts = [];
        if (i > segStart) parts.push(text.slice(segStart, i));
        parts.push('"');
        pos = i + 2;
        segStart = pos;
        continue;
      }
      if (parts === null) {
        value = text.slice(segStart, i);
      } else {
        if (i > segStart) parts.push(text.slice(segStart, i));
        value = parts.join('');
      }
      pos = i + 1;
      closed = true;
      break;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    if (pos >= n) { fValue = value; fEnded = TEXT_END; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fValue = value; fEnded = COMMA_END; return; }
    if (c === 10) { pos += 1; line += 1; fValue = value; fEnded = BREAK_END; return; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line += 1; fValue = value; fEnded = BREAK_END; return;
    }
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    while (pos < n) {
      const ch = text.charCodeAt(pos);
      if (ch === 10) { pos += 1; line += 1; }
      else if (ch === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        readQuoted();
        quoted = true;
      } else {
        readUnquoted(null);
        quoted = false;
      }
      fields.push(fValue);
    } while (fEnded === COMMA_END);

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
