import { retryAfterSeconds } from 'src/services/network/rpcExchange';

export async function handleNetworkRequest(message: any, sendResponse: (response?: any) => void) {
  try {
    const { url, method = 'GET', headers = {}, body } = message;
    const requestOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    if (method.toUpperCase() === 'POST' && body) {
      requestOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, requestOptions);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_e) {}

    sendResponse({
      success: true,
      status: response.status,
      text,
      json,
      retryAfter: retryAfterSeconds(response.headers.get('Retry-After')),
    });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}
