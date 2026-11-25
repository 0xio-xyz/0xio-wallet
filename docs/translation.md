# Translation

The wallet ships in English, Bahasa Indonesia, Simplified Chinese, Japanese and Korean. Translation runs on a small built-in library in `src/i18n/`, with no i18n package.

## Where the code lives

| Path | What it holds |
|------|---------------|
| `src/i18n/locales/<code>.json` | One flat JSON file per language: `en`, `id`, `zh`, `ja`, `ko` |
| `src/i18n/index.ts` | `LANGUAGES` (code and label shown in Settings), resource loading, `setLanguage`, `loadSavedLanguage` |
| `src/i18n/core.ts` | Lookup, fallback, plurals and interpolation |
| `src/i18n/react.tsx` | `useTranslation`, `withTranslation` and `Trans` for React |
| `src/i18n/__tests__/` | Behaviour tests with shared vectors |

## How it works

- Keys are flat strings with dots, for example `"common.confirm": "Confirm"`.
- A key missing from a language falls back to English. A key missing from English shows the `defaultValue` passed to `t()`, else the key itself.
- Values take `{{name}}` placeholders: `t('nft.itemCount', { count: 3 })`.
- Plurals use `Intl.PluralRules` suffixes: `_one`, `_other` and the other forms a language needs, plus `_zero` for a count of 0.
- `Trans` renders tags such as `<b>...</b>` inside a value with the components you pass.
- The chosen language is stored as `app_language` in `chrome.storage.local` and loaded when the popup opens.

## Add or change a string

1. Add the key to `src/i18n/locales/en.json`.
2. Add the same key to the other locale files. A key left out shows English in that language.
3. Use it in the component with `const { t } = useTranslation();` and `t('area.key')`.

## Add a language

1. Copy `src/i18n/locales/en.json` to `src/i18n/locales/<code>.json` and translate the values. Keep the keys and the `{{placeholders}}` unchanged.
2. Import it in `src/i18n/index.ts`, add it to `resources` in `i18n.init`, and add `{ code, label }` to `LANGUAGES`. The label is the language's own name.
3. Add the plural forms the language needs (`Intl.PluralRules` decides which).
4. Run `npm test` and check the screens at the popup's width: translated text may run longer than English.

## Writing rules

- Sentence case. No taglines or helper text; errors and changing status only.
- No em or en dashes, middots or checkmarks. No comma or middot as a separator in labels.
- Keep product and token names as they are (0xio, Octra, OCT, wOCT).
