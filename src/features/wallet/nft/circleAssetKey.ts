export const circleAssetKey = (networkId: string, circleId: string, path: string) =>
  `${networkId}|${circleId}|${path}`;

// A circle file can change at the same path: documents are never kept on disk.
export const isDurableAsset = (path: string, contentType = '') =>
  !/\.(json|html?)$/i.test(path) && !/^(application\/json|text\/html)/i.test(contentType);
