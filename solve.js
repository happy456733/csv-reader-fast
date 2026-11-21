// solve.js — fast, dependency-free CSV reader compatible with csv-reader 1.0.0.
//
// Written from the parsing semantics specified in RULES.txt only:
//   - A U+FEFF at the very start is dropped.
//   - A record ends at LF or CRLF; a line left with no characters is no record.
//   - Outside quotes a CR not followed by LF is dropped (error stray_cr).
//   - A field opening with a quote runs to the next quote that is not doubled;
//     "" inside it is one quote and each CRLF or lone CR inside it reads as LF.
//     What follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends).
//   - A quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote).
//   - A quote inside an unquoted field is a literal character.
//   - Fields stay strings, never trimmed or converted.
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width.
//   - Each error is {code, line, row}, in the order met; a record's short_row
//     or long_row fires when it ends, with line the 1-based line its record
//     starts on and row its index in rows (null for the header).

export function run(input) {
  const text = input.text;
  const header = input.header === true;
  const n = text.length;
  let i = 0;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) i = 1;

  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let line = 1;
  let recCount = 0;

  // Parse one unquoted field starting at p0 (parts0 holds already-collected
  // leading pieces, e.g. the literal opening quote of an unterminated field).
  // Returns {value, endKind} with endKind 0 = comma, 1 = record end, 2 = EOF.
  // Advances the shared cursor i and line counter.
  function parseUnquoted(p0, parts0, rowForErr) {
    let p = p0;
    let parts = parts0;
    for (;;) {
      const comma = text.indexOf(',', p);
      const lf = text.indexOf('\n', p);
      let end = -1;
      let kind = 2;
      if (comma !== -1 && (lf === -1 || comma < lf)) {
        end = comma;
        kind = 0;
      } else if (lf !== -1) {
        end = lf;
        kind = 1;
      }
      const cr = text.indexOf('\r', p);
      if (cr !== -1 && (end === -1 || cr < end)) {
        if (kind === 1 && cr === end - 1) {
          // CRLF: the field ends at the CR and the record ends.
          const value = parts === null ? text.slice(p, cr) : parts.join('') + text.slice(p, cr);
          i = end + 1;
          line++;
          return { value, endKind: 1 };
        }
        // Stray CR: dropped, error, and the field continues past it.
        errors.push({ code: 'stray_cr', line, row: rowForErr });
        if (parts === null) parts = [text.slice(p, cr)];
        else parts.push(text.slice(p, cr));
        p = cr + 1;
        continue;
      }
      if (kind === 2) {
        const value = parts === null ? text.slice(p) : parts.join('') + text.slice(p);
        i = n;
        return { value, endKind: 2 };
      }
      if (kind === 0) {
        const value = parts === null ? text.slice(p, end) : parts.join('') + text.slice(p, end);
        i = end + 1;
        return { value, endKind: 0 };
      }
      const value = parts === null ? text.slice(p, end) : parts.join('') + text.slice(p, end);
      i = end + 1;
      line++;
      return { value, endKind: 1 };
    }
  }

  while (i < n) {
    const c0 = text.charCodeAt(i);
    if (c0 === 10) {
      i++;
      line++;
      continue;
    }
    if (c0 === 13 && text.charCodeAt(i + 1) === 10) {
      i += 2;
      line++;
      continue;
    }

    const startLine = line;
    const rowForErr = header ? (recCount === 0 ? null : recCount - 1) : recCount;
    const fields = [];
    let recDone = false;
    let eof = false;

    while (!recDone && !eof) {
      let value;
      let endKind;

      if (text.charCodeAt(i) === 34) {
        // ---- quoted field ----
        let q = i + 1;
        const segs = [];
        let closedAt = -1;
        for (;;) {
          const close = text.indexOf('"', q);
          if (close === -1) break;
          if (text.charCodeAt(close + 1) === 34) {
            segs.push(text.slice(q, close));
            segs.push('"');
            q = close + 2;
            continue;
          }
          segs.push(text.slice(q, close));
          closedAt = close;
          break;
        }

        if (closedAt === -1) {
          // Unterminated: the opening quote is literal; the text after it is
          // read again as unquoted.
          errors.push({ code: 'unterminated_quote', line, row: rowForErr });
          const r = parseUnquoted(i + 1, ['"'], rowForErr);
          value = r.value;
          endKind = r.endKind;
        } else {
          // Commit the segments: CR/LF inside quotes reads as LF, and every
          // line break inside quotes advances the line count.
          const out = [];
          for (let s = 0; s < segs.length; s++) {
            const seg = segs[s];
            if (seg === '"') {
              out.push('"');
              continue;
            }
            if (seg.indexOf('\r') === -1) {
              if (seg.indexOf('\n') !== -1) {
                let b = 0;
                for (let k = 0; k < seg.length; k++) if (seg.charCodeAt(k) === 10) b++;
                line += b;
              }
              out.push(seg);
            } else {
              let b = 0;
              out.push(seg.replace(/\r\n?|\n/g, () => {
                b++;
                return '\n';
              }));
              line += b;
            }
          }

          // Junk after the closing quote, up to the next comma or line break.
          const junkLine = line;
          let j = closedAt + 1;
          let junk = '';
          let jEnd = 2;
          for (;;) {
            const comma = text.indexOf(',', j);
            const lf = text.indexOf('\n', j);
            let end = -1;
            let kind = 2;
            if (comma !== -1 && (lf === -1 || comma < lf)) {
              end = comma;
              kind = 0;
            } else if (lf !== -1) {
              end = lf;
              kind = 1;
            }
            const cr = text.indexOf('\r', j);
            if (cr !== -1 && (end === -1 || cr < end)) {
              if (kind === 1 && cr === end - 1) {
                junk += text.slice(j, cr);
                j = end + 1;
                line++;
                jEnd = 1;
                break;
              }
              errors.push({ code: 'stray_cr', line, row: rowForErr });
              junk += text.slice(j, cr);
              j = cr + 1;
              continue;
            }
            if (kind === 2) {
              junk += text.slice(j);
              j = n;
              jEnd = 2;
            } else if (kind === 0) {
              junk += text.slice(j, end);
              j = end + 1;
              jEnd = 0;
            } else {
              junk += text.slice(j, end);
              j = end + 1;
              line++;
              jEnd = 1;
            }
            break;
          }
          if (junk !== '') errors.push({ code: 'quote_junk', line: junkLine, row: rowForErr });
          value = out.join('') + junk;
          i = j;
          endKind = jEnd;
        }
      } else {
        const r = parseUnquoted(i, null, rowForErr);
        value = r.value;
        endKind = r.endKind;
      }

      fields.push(value);
      if (endKind === 1) recDone = true;
      else if (endKind === 2) eof = true;
    }

    // A record's short_row / long_row fires when the record ends.
    if (recCount === 0) {
      width = fields.length;
      if (header) columns = fields;
      else rows.push(fields);
    } else {
      const rowIdx = header ? recCount - 1 : recCount;
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: startLine, row: rowIdx, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: startLine, row: rowIdx, extra: fields.slice(width) });
        fields.length = width;
      }
      rows.push(fields);
    }
    recCount++;
  }

  if (header && columns === null) columns = [];
  return { columns, rows, errors };
}
