/**
 * `multipart/form-data` parsing, because Execute Webhook accepts file uploads
 * and no dependency here is worth taking for it.
 *
 * Deliberately buffer-based rather than streaming: the whole body is already in
 * memory by the time this is called (the server enforces a size cap before
 * reading), and a streaming parser would add a state machine to maintain for no
 * behaviour anyone would notice at these sizes.
 *
 * The one thing that is easy to get wrong and is done carefully here: part
 * bodies are BINARY. Searching for boundaries by converting the body to a
 * string corrupts every non-UTF-8 byte in an uploaded file - the classic
 * symptom being an image that arrives the right length and will not decode.
 * Everything below indexes Buffers.
 */

export type MultipartField = {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
};

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

/** The `boundary=` parameter, unquoted. Null when the header is not multipart. */
export function parseBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  if (!/^multipart\/form-data/i.test(contentType.trim())) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  return boundary === '' ? null : boundary;
}

const parseHeaders = (raw: string): Record<string, string> => {
  const headers: Record<string, string> = {};
  raw.split('\r\n').forEach((line) => {
    const index = line.indexOf(':');
    if (index <= 0) return;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  });
  return headers;
};

/**
 * `name="x"; filename="y"` - values may be quoted and may contain semicolons
 * inside the quotes, which a naive split on `;` gets wrong for any filename
 * with a semicolon in it.
 */
const parseDisposition = (value: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z0-9*-]+)=(?:"((?:[^"\\]|\\.)*)"|([^;]+))/g;
  let match = re.exec(value);
  while (match !== null) {
    const raw = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : (match[3] ?? '');
    const key = match[1];
    if (key !== undefined) out[key.toLowerCase()] = raw.trim();
    match = re.exec(value);
  }
  return out;
};

/**
 * Splits a multipart body into its fields.
 *
 * Returns an empty array for a body that does not parse rather than throwing:
 * the caller answers a malformed request with 400 either way, and an exception
 * here would have to be caught at every call site to say the same thing.
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartField[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: MultipartField[] = [];

  let position = body.indexOf(delimiter);
  if (position === -1) return fields;

  while (position !== -1) {
    let cursor = position + delimiter.length;

    // `--` after the delimiter marks the final boundary; anything after it is
    // epilogue and is ignored, as the grammar requires.
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;

    // Skip the transport padding and the CRLF that ends the boundary line.
    const lineEnd = body.indexOf(CRLF, cursor);
    if (lineEnd === -1) break;
    cursor = lineEnd + CRLF.length;

    const headerEnd = body.indexOf(DOUBLE_CRLF, cursor);
    if (headerEnd === -1) break;

    const headers = parseHeaders(body.subarray(cursor, headerEnd).toString('utf8'));
    const bodyStart = headerEnd + DOUBLE_CRLF.length;

    const next = body.indexOf(delimiter, bodyStart);
    if (next === -1) break;

    // The CRLF immediately before the next delimiter belongs to the delimiter,
    // not to the part. Including it appends two stray bytes to every upload.
    const bodyEnd = next >= CRLF.length && body.subarray(next - CRLF.length, next).equals(CRLF)
      ? next - CRLF.length
      : next;

    const disposition = parseDisposition(headers['content-disposition'] ?? '');
    if (disposition.name !== undefined) {
      fields.push({
        name: disposition.name,
        filename: disposition.filename,
        contentType: headers['content-type'],
        data: body.subarray(bodyStart, bodyEnd),
      });
    }

    position = next;
  }

  return fields;
}
