// Strip a leading UTF-8 byte-order mark (U+FEFF) from a string before
// JSON.parse-ing it. JSON.parse does not treat a BOM as insignificant
// whitespace and throws "Unexpected token" if one is present. Windows
// PowerShell's default `-Encoding utf8` (on Windows PowerShell 5.1, as
// opposed to PowerShell 7+) writes one, and so do some text editors, so
// sources.json can pick one up without the person editing it realizing.
export function stripBom(text) {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}
