// The Chrome build (vite.config.js) does NOT define them -
// code reads them only through `typeof` guards (see src/shared/buildTarget.ts), which is safe on
// an undeclared global.
declare const __FIREFOX__: boolean | undefined;
declare const __CHROME__: boolean | undefined;
declare const __EXT_VERSION__: string | undefined;
