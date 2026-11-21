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
  function parseUnquoted(p0, parts0, rowForErr, startLine) {
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
      if (kind === 1 && end > p && text.charCodeAt(end - 1) === 13) {
        // CRLF ending: the value is the slice without the CR, unless a stray
        // CR hides inside it.
        const v = text.slice(p, end - 1);
        if (v.indexOf('\r') === -1) {
          i = end + 1;
          line++;
          return { value: parts === null ? v : parts.join('') + v, endKind: 1 };
        }
      } else if (kind !== 2) {
        const v = text.slice(p, end);
        if (v.indexOf('\r') === -1) {
          i = end + 1;
          if (kind === 1) line++;
          return { value: parts === null ? v : parts.join('') + v, endKind: kind };
        }
      } else {
        const v = text.slice(p);
        if (v.indexOf('\r') === -1) {
          i = n;
          return { value: parts === null ? v : parts.join('') + v, endKind: 2 };
        }
      }
      // Slow path: a stray CR sits inside the field. Drop it, report it, and
      // keep reading the same field past it.
      const cr = text.indexOf('\r', p);
      errors.push({ code: 'stray_cr', line: startLine, row: rowForErr });
      if (parts === null) parts = [text.slice(p, cr)];
      else parts.push(text.slice(p, cr));
      p = cr + 1;
    }
  }

  // Junk after a closing quote, from j0, appended to prefix. Returns
  // {value, endKind}; advances the shared cursor i and line counter.
  function parseJunk(j0, prefix, rowForErr, startLine) {
    let j = j0;
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
      if (kind === 1 && end > j && text.charCodeAt(end - 1) === 13) {
        const v = text.slice(j, end - 1);
        if (v.indexOf('\r') === -1) {
          junk += v;
          j = end + 1;
          line++;
          jEnd = 1;
          break;
        }
      } else if (kind !== 2) {
        const v = text.slice(j, end);
        if (v.indexOf('\r') === -1) {
          junk += v;
          j = end + 1;
          if (kind === 1) line++;
          jEnd = kind;
          break;
        }
      } else {
        const v = text.slice(j);
        if (v.indexOf('\r') === -1) {
          junk += v;
          j = n;
          jEnd = 2;
          break;
        }
      }
      const cr = text.indexOf('\r', j);
      errors.push({ code: 'stray_cr', line: startLine, row: rowForErr });
      junk += text.slice(j, cr);
      j = cr + 1;
    }
    if (junk !== '') errors.push({ code: 'quote_junk', line: startLine, row: rowForErr });
    return { value: prefix + junk, endKind: jEnd, next: j };
  }

  // Normalise one quoted segment: every CRLF or lone CR inside quotes reads
  // as LF, and each such line break advances the line count.
  function normaliseSeg(seg) {
    if (seg.indexOf('\r') === -1) {
      if (seg.indexOf('\n') !== -1) {
        let b = 0;
        for (let k = 0; k < seg.length; k++) if (seg.charCodeAt(k) === 10) b++;
        line += b;
      }
      return seg;
    }
    let b = 0;
    const out = seg.replace(/\r\n?|\n/g, () => {
      b++;
      return '\n';
    });
    line += b;
    return out;
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
        const close = text.indexOf('"', i + 1);
        if (close === -1) {
          // Unterminated: the opening quote is literal; the text after it is
          // read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: startLine, row: rowForErr });
          const r = parseUnquoted(i + 1, ['"'], rowForErr, startLine);
          value = r.value;
          endKind = r.endKind;
        } else if (text.charCodeAt(close + 1) !== 34) {
          // Fast path: one segment, no doubled quotes.
          const seg = normaliseSeg(text.slice(i + 1, close));
          const c = text.charCodeAt(close + 1);
          if (c === 44) {
            value = seg;
            i = close + 2;
            endKind = 0;
          } else if (c === 10) {
            value = seg;
            i = close + 2;
            line++;
            endKind = 1;
          } else if (c === 13 && text.charCodeAt(close + 2) === 10) {
            value = seg;
            i = close + 3;
            line++;
            endKind = 1;
          } else if (close + 1 >= n) {
            value = seg;
            i = n;
            endKind = 2;
          } else {
            const r = parseJunk(close + 1, seg, rowForErr, startLine);
            value = r.value;
            i = r.next;
            endKind = r.endKind;
          }
        } else {
          // Doubled quotes inside: collect segments until the close.
          let q = close + 2;
          const segs = [text.slice(i + 1, close), '"'];
          let closedAt = -1;
          for (;;) {
            const nx = text.indexOf('"', q);
            if (nx === -1) break;
            if (text.charCodeAt(nx + 1) === 34) {
              segs.push(text.slice(q, nx));
              segs.push('"');
              q = nx + 2;
              continue;
            }
            segs.push(text.slice(q, nx));
            closedAt = nx;
            break;
          }
          if (closedAt === -1) {
            errors.push({ code: 'unterminated_quote', line: startLine, row: rowForErr });
            const r = parseUnquoted(i + 1, ['"'], rowForErr, startLine);
            value = r.value;
            endKind = r.endKind;
          } else {
            const out = [];
            for (let s = 0; s < segs.length; s++) {
              const seg = segs[s];
              if (seg === '"') out.push('"');
              else out.push(normaliseSeg(seg));
            }
            const prefix = out.join('');
            const c = text.charCodeAt(closedAt + 1);
            if (c === 44) {
              value = prefix;
              i = closedAt + 2;
              endKind = 0;
            } else if (c === 10) {
              value = prefix;
              i = closedAt + 2;
              line++;
              endKind = 1;
            } else if (c === 13 && text.charCodeAt(closedAt + 2) === 10) {
              value = prefix;
              i = closedAt + 3;
              line++;
              endKind = 1;
            } else if (closedAt + 1 >= n) {
              value = prefix;
              i = n;
              endKind = 2;
            } else {
              const r = parseJunk(closedAt + 1, prefix, rowForErr, startLine);
              value = r.value;
              i = r.next;
              endKind = r.endKind;
            }
          }
        }
      } else {
        // ---- unquoted field (inlined hot path) ----
        let p = i;
        let parts = null;
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
          if (kind === 1 && end > p && text.charCodeAt(end - 1) === 13) {
            const v = text.slice(p, end - 1);
            if (v.indexOf('\r') === -1) {
              value = parts === null ? v : parts.join('') + v;
              i = end + 1;
              line++;
              endKind = 1;
              break;
            }
          } else if (kind !== 2) {
            const v = text.slice(p, end);
            if (v.indexOf('\r') === -1) {
              value = parts === null ? v : parts.join('') + v;
              i = end + 1;
              if (kind === 1) line++;
              endKind = kind;
              break;
            }
          } else {
            const v = text.slice(p);
            if (v.indexOf('\r') === -1) {
              value = parts === null ? v : parts.join('') + v;
              i = n;
              endKind = 2;
              break;
            }
          }
          // Slow path: a stray CR sits inside the field. Drop it, report
          // it, and keep reading the same field past it.
          const cr = text.indexOf('\r', p);
          errors.push({ code: 'stray_cr', line: startLine, row: rowForErr });
          if (parts === null) parts = [text.slice(p, cr)];
          else parts.push(text.slice(p, cr));
          p = cr + 1;
        }
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
