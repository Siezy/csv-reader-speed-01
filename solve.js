// Fast drop-in replacement for csv-reader 1.0.0 (make.fun csv-reader-speed-01), written from the
// competition spec. Returns exactly csv-reader 1.0.0's answer for every input {text, header}:
// {columns, rows, errors} under its broken-row policy (BOM dropped; records end at LF or CRLF;
// blank lines are no records; a lone CR outside quotes is dropped as stray_cr; a quoted field runs
// to the next undoubled quote with "" read as one quote and CRLF / lone CR inside read as LF; junk
// after a closing quote is appended as it stands, quote_junk; a quote that never closes is a literal
// character and the rest is re-read unquoted, unterminated_quote; rows are padded with "" (short_row)
// or cut (long_row) to the first record's width; errors are {code, line, row} in the order met).
//
// Speed: the scan never walks the text character by character and never rescans a gap. The
// positions of the next '"' and the next '\r' are kept as monotonically advancing indexOf cursors
// (each cursor's total scanning is linear over the whole parse), so a record first learns from its
// cursors whether its span (up to the next LF) holds a quote or an interior CR: if not, its fields
// are sliced out on commas directly. Records that do hold one are read by an exact indexOf-driven
// state machine that slices fields and only assembles a field from parts when a stray CR, a doubled
// quote or a CR inside quotes actually occurs. Field readers report through shared variables
// instead of allocating a result object per field.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const s = String(input.text);
  const header = input.header === true;
  const n = s.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (s.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field last read by the slow-path readers (shared scratch, reset by every reader call).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Monotonically advancing cursors: the index of the next '"' / '\r' at or after the position
  // they were last refreshed for, or -1 when none is left. They only move forward, so the total
  // scanning they do over one parse is linear in the text length.
  let nq = -2;
  let nr = -2;
  function nextQuote(from) {
    if (nq === -2 || (nq !== -1 && nq < from)) nq = s.indexOf('"', from);
    return nq;
  }
  function nextCR(from) {
    if (nr === -2 || (nr !== -1 && nr < from)) nr = s.indexOf('\r', from);
    return nr;
  }

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // A quoted field's raw segment s[a..b): every CRLF and lone CR inside quotes is read as one LF and
  // counts one line, as does every LF. Returns the segment's value; advances `line` past it.
  function quotedSegment(a, b) {
    if (a === b) return '';
    const t = s.slice(a, b);
    if (t.indexOf('\r') === -1) {
      let i = t.indexOf('\n');
      if (i === -1) return t;
      let cnt = 0;
      while (i !== -1) {
        cnt += 1;
        i = t.indexOf('\n', i + 1);
      }
      line += cnt;
      return t;
    }
    const out = t.replace(/\r\n|\r/g, '\n');
    let cnt = 0;
    let i = out.indexOf('\n');
    while (i !== -1) {
      cnt += 1;
      i = out.indexOf('\n', i + 1);
    }
    line += cnt;
    return out;
  }

  // Reads unquoted characters onto `prefix` up to the next comma or line break; a CR not followed by
  // LF is dropped (stray_cr). Sets fValue / fEnded / fAdded (fAdded: characters kept, prefix aside).
  function readUnquoted(prefix) {
    let start = pos;
    let parts = null;
    let added = 0;
    for (;;) {
      const nc = s.indexOf(',', pos);
      const nn = s.indexOf('\n', pos);
      const rc = nextCR(pos);
      let j = -1;
      let kind = -1;
      if (nc !== -1) { j = nc; kind = COMMA; }
      if (nn !== -1 && (j === -1 || nn < j)) { j = nn; kind = LINE_BREAK; }
      if (rc !== -1 && (j === -1 || rc < j)) { j = rc; kind = 3; }
      if (j === -1) {
        const tail = s.slice(start, n);
        added += n - start;
        fValue = parts === null ? prefix + tail : prefix + parts.join('') + tail;
        fEnded = END;
        fAdded = added;
        pos = n;
        return;
      }
      if (kind === 3 && s.charCodeAt(j + 1) !== 10) {
        // A lone CR: an error, the character dropped, the field goes on.
        pushError('stray_cr');
        if (j > start) {
          if (parts === null) parts = [];
          parts.push(s.slice(start, j));
          added += j - start;
        }
        pos = j + 1;
        start = pos;
        continue;
      }
      const tail = s.slice(start, j);
      added += j - start;
      fValue = parts === null ? prefix + tail : prefix + parts.join('') + tail;
      fAdded = added;
      if (kind === COMMA) {
        fEnded = COMMA;
        pos = j + 1;
      } else if (kind === LINE_BREAK) {
        fEnded = LINE_BREAK;
        pos = j + 1;
        line += 1;
      } else {
        // A CR that is followed by LF: the record ends.
        fEnded = LINE_BREAK;
        pos = j + 2;
        line += 1;
      }
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue / fEnded (fAdded via junk only).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let parts = null;
    for (;;) {
      const j = nextQuote(pos);
      if (j === -1) {
        // The quote never closes: it is a literal character, the rest is read again as unquoted.
        // The rewind moves pos backwards, past where the cursors may already have scanned, so
        // they are invalidated and refresh from the rewound position on their next use.
        pos = open + 1;
        line = openLine;
        nq = -2;
        nr = -2;
        pushError('unterminated_quote');
        readUnquoted('"');
        return;
      }
      if (s.charCodeAt(j + 1) === 34) {
        // A doubled quote: one quote, the field goes on.
        if (parts === null) parts = [];
        parts.push(quotedSegment(segStart, j), '"');
        pos = j + 2;
        segStart = pos;
        continue;
      }
      let value;
      if (parts === null) {
        value = quotedSegment(segStart, j);
      } else {
        parts.push(quotedSegment(segStart, j));
        value = parts.join('');
      }
      pos = j + 1;
      if (pos >= n) {
        fValue = value;
        fEnded = END;
        return;
      }
      const c = s[pos];
      if (c === ',') {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        return;
      }
      if (c === '\n') {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        return;
      }
      if (c === '\r' && s.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line break.
      readUnquoted(value);
      if (fAdded > 0) pushError('quote_junk');
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = s[pos];
      if (c === '\n') {
        pos += 1;
        line += 1;
      } else if (c === '\r' && s.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let lastQuoted = false;

    // Fast path: the record's span holds no '"' and no interior '\r', so it reads as plain fields
    // split on commas, ending at the next LF (a '\r' right before it is the CRLF's) or at the end.
    const lf = s.indexOf('\n', pos);
    const spanEnd = lf === -1 ? n : lf;
    const contentEnd = lf !== -1 && spanEnd > pos && s.charCodeAt(spanEnd - 1) === 13 ? spanEnd - 1 : spanEnd;
    const qi = nextQuote(pos);
    const ri = nextCR(pos);
    if ((qi === -1 || qi >= contentEnd) && (ri === -1 || ri >= contentEnd)) {
      fields = [];
      let i = pos;
      for (;;) {
        const j = s.indexOf(',', i);
        if (j === -1 || j >= contentEnd) {
          fields.push(s.slice(i, contentEnd));
          break;
        }
        fields.push(s.slice(i, j));
        i = j + 1;
      }
      pos = lf === -1 ? n : lf + 1;
      if (lf !== -1) line += 1;
    } else {
      fields = [];
      let quoted;
      do {
        quoted = s[pos] === '"';
        if (quoted) readQuoted();
        else readUnquoted('');
        fields.push(fValue);
      } while (fEnded === COMMA);
      lastQuoted = quoted;
    }

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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
