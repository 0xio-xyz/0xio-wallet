(function () {
  if (window.__0xioSdkBridgeLoaded) {
    return;
  }
  window.__0xioSdkBridgeLoaded = true;

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data) return;

    if (event.data.source === '0xio-sdk-request' || event.data.type === '0xio-sdk-request') {
      const request = event.data.request || event.data;
      const requestId = request.id || event.data.id;
      const forwardedMessage = {
        source: '0xio-wallet-injected',
        requestId: requestId,
        method: request.method || event.data.method,
        params: request.params || event.data.params,
      };

      window.postMessage(forwardedMessage, window.location.origin);
    }
  });

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data) return;

    if (event.data.source === '0xio-wallet-content') {
      if (event.data.response) {
        const sdkResponse = {
          source: '0xio-sdk-bridge',
          response: {
            id: event.data.requestId,
            success: event.data.response.success,
            data: event.data.response.data,
            error: event.data.response.error,
            timestamp: Date.now(),
          },
        };

        window.postMessage(sdkResponse, window.location.origin);
      } else if (event.data.type === 'disconnect') {
        window.postMessage(
          {
            source: '0xio-sdk-bridge',
            event: {
              type: 'disconnect',
              data: event.data.data,
              timestamp: Date.now(),
            },
          },
          window.location.origin
        );
      } else if (event.data.type === 'event') {
        window.postMessage(
          {
            source: '0xio-sdk-bridge',
            event: event.data.eventData,
          },
          window.location.origin
        );
      }
    }
  });
})();
