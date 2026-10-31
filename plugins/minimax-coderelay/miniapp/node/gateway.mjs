import { problem } from './state.mjs';

export function gatewayUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw problem('INVALID_GATEWAY_URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw problem('HTTPS_REQUIRED');
  if (url.username || url.password || url.search || url.hash) throw problem('INVALID_GATEWAY_URL');
  return url.href.replace(/\/+$/, '');
}

export class Gateway {
  constructor(connection, fetchImpl = fetch) {
    this.connection = connection;
    this.fetch = fetchImpl;
  }

  async request(path, body, { signal, anonymous = false } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (!anonymous) headers.authorization = `Bearer ${this.connection.token}`;
    const timeout = AbortSignal.timeout(20000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetch(`${this.connection.gatewayUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
        redirect: 'error',
      });
    } catch (error) {
      throw problem(
        error?.name === 'AbortError' || combined.aborted
          ? 'NETWORK_TIMEOUT'
          : 'NETWORK_UNAVAILABLE',
        502,
      );
    }
    const reader = response.body?.getReader();
    let chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw problem('GATEWAY_RESPONSE_TOO_LARGE', 502);
        }
        chunks.push(value);
      }
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw problem('GATEWAY_INVALID_JSON', 502);
    }
    if (!response.ok) {
      const code = data?.error?.code;
      throw problem(
        typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code)
          ? code.toUpperCase()
          : 'GATEWAY_REJECTED',
        response.status,
      );
    }
    return data;
  }
}
