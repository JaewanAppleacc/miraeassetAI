// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section J: PostgreSQL COPY
// text-format encode/decode helpers shared by the file-spool writer and the
// native `psql \copy` loader. COPY text format: columns tab-separated, rows
// newline-terminated; backslash/tab/newline/carriage-return are escaped as
// \\ \t \n \r; SQL NULL is the two-character sequence \N (unescaped -- a
// value that itself needs to read as \N after escaping is impossible, since
// escaping always doubles a literal backslash first, so a real value can
// never collide with the NULL sentinel). PostgreSQL text/varchar columns
// cannot store an embedded NUL byte at all (a server-side, not
// COPY-specific, limitation) -- fail-closed rather than silently
// dropping/mangling one.
const NUL_CHAR = String.fromCharCode(0);

export function copyEncodeField(value) {
  if (value === null || value === undefined) return "\\N";
  const str = String(value);
  if (str.indexOf(NUL_CHAR) !== -1) {
    throw new Error("COPY_FIELD_CONTAINS_NUL_BYTE: PostgreSQL text columns cannot store an embedded NUL byte");
  }
  return str
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

// Builds one COPY text-format row from an ordered array of raw (unescaped)
// field values -- null/undefined become \N, everything else is
// stringified + escaped via copyEncodeField.
export function copyEncodeRow(values) {
  return values.map(copyEncodeField).join("\t");
}
