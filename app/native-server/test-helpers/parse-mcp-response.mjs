/**
 * Parse a Streamable-HTTP MCP response body. The bridge replies either with
 * `Content-Type: application/json` (single object) or `text/event-stream`
 * (one or more `event:`/`data:` frames).
 *
 * Returns the JSON-parsed payload of the *last* `data:` frame, or the raw
 * object for plain JSON responses. Always returning the last frame matters
 * for tools like `tools/call` where the server may emit progress events
 * before the final result.
 */
export function parseMcpResponseBody(text) {
  if (!text) return null;
  if (text.includes('event:') && text.includes('data:')) {
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    const last = dataLines[dataLines.length - 1];
    if (!last) return null;
    try {
      return JSON.parse(last);
    } catch {
      return last;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
