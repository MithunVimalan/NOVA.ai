export interface JsonRequestOptions {
  /** Label used in thrown error messages, e.g. "Deepgram API". */
  label: string;
  method?: string;
  headers?: Record<string, string>;
  /** Value serialized as a JSON request body. */
  body?: unknown;
  /** Pre-encoded body used as-is (binary uploads); takes precedence over `body`. */
  rawBody?: BodyInit;
  signal?: AbortSignal;
}

/**
 * Performs an HTTP request and parses the JSON response, throwing a labelled
 * error containing the status and response text when the call fails.
 */
export async function requestJson<T>(url: string, options: JsonRequestOptions): Promise<T> {
  const { label, method = 'POST', headers = {}, body, rawBody, signal } = options;

  const requestBody = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const requestHeaders = rawBody || body === undefined
    ? headers
    : { 'Content-Type': 'application/json', ...headers };

  const response = await fetch(url, { method, headers: requestHeaders, body: requestBody, signal });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`${label} returned HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`);
  }

  return await response.json() as T;
}

/**
 * Builds the standard bearer-token JSON headers used by third-party APIs.
 */
export function bearerJsonHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}
