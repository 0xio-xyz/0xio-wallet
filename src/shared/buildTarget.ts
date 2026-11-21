export const IS_FIREFOX: boolean =
  typeof __FIREFOX__ !== 'undefined'
    ? !!__FIREFOX__
    : typeof chrome !== 'undefined' && !('offscreen' in chrome);

export const IS_CHROME: boolean = !IS_FIREFOX;
