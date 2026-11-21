declare global {
  interface Window {
    global: typeof globalThis;
  }
}

if (typeof window !== 'undefined') {
  window.global = window;
}

import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from 'src/shared/ui/ErrorBoundary';
import './css/main.css';

import 'src/i18n';
import { loadSavedLanguage } from 'src/i18n';

loadSavedLanguage();

const rootElement = document.getElementById('root');
// Wide/full-tab layout is opened explicitly by ExpandViewToggle with ?view=expanded. Detect that
// marker rather than guessing from window size - Firefox misreports popup dimensions.
const isFullscreen = new URLSearchParams(window.location.search).get('view') === 'expanded';

if (isFullscreen) {
  // Mark both <html> and <body> so CSS can size the document element too (Firefox sizes the popup
  // from the document root's preferred width - see the html rules in css/main.css).
  document.documentElement.classList.add('is-fullscreen');
  document.body.classList.add('is-fullscreen');
}

ReactDOM.createRoot(rootElement).render(
  <ErrorBoundary>
    <App isFullscreen={isFullscreen} />
  </ErrorBoundary>
);
