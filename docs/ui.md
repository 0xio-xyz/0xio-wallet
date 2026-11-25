# UI

The UI is one React 18 app (`index.html` -> `src/main.tsx` -> `src/App.tsx`). The toolbar popup, the expanded tab (`?view=expanded`) and the review windows the worker opens all load it; the route decides what shows.

## Where the code lives

| Path | What it holds |
|------|---------------|
| `src/App.tsx` | Routes, lock and onboarding redirects, the footer |
| `src/features/` | Screens by area: `wallet`, `transactions`, `privacy`, `bridge`, `dapp`, `settings`, `security` |
| `src/shared/ui/` | Shared components (buttons, inputs, sheets, transaction rows, icons) |
| `src/hooks/` | Hooks by area: `wallet`, `transactions`, `privacy`, `dapp`, `ui` |
| `src/contexts/` | `WalletContext` (wallets, active network, balances) and `ThemeContext` |
| `src/lib/router/` | The app's own in-memory router |
| `src/lib/` | Self-contained helpers: QR, encoding, sanitizer, wallet art |
| `src/css/` | Tailwind 4 theme tokens (`globals.css`) and component styles |
| `src/i18n/` | Translations; see [translation.md](translation.md) |
| `renderer.html`, `src/renderer/` | Sandboxed page for living NFTs (Chrome) |

## Routing

`src/lib/router` provides `MemoryRouter`, `Routes`, `Route`, `Navigate` and the usual hooks. The first entry comes from the URL hash, so the worker opens a review with `index.html#/dapp-approval/<id>`, `#/approve-transaction/<id>`, `#/approve-message/<id>` or `#/evm-approval/<id>`. Home, Collectibles, Lock, Onboarding and Setup are in the main bundle; every other screen loads on demand through `lazyScreen` (`src/utils/lazyScreen.ts`).

## Themes

Three themes: Dim (default), Light and Octra. `ThemeContext` sets `data-theme` on `<html>` and stores the choice as `app_theme` in `chrome.storage.local`. Colors are CSS variables defined per theme in `src/css/globals.css` and exposed to Tailwind through `@theme`; components use these tokens.

## Rules

- Every transaction, approvals included, opens a review before signing. Extension reviews use a button pair (Reject plus the verb), never a slide.
- Balances and lists come from `WalletContext` and hooks that scope every value to network plus address. A value read for another wallet or network is never shown, and an unknown value shows as `--`, never 0.
- Loading never moves content: slots are reserved and the last content stays, dimmed, while new data loads.
- Avoid a direct `useEffect` in components. Use `useMountEffect` (`src/hooks/ui/useMountEffect.ts`), or tag an effect that cannot be avoided with `// effect:audited - <reason>`.
- Every visible string goes through `t()`; see [translation.md](translation.md).
- The runtime dependency tree is the short list in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Prefer a small helper in `src/lib/` over a new package.
