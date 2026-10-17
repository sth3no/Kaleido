import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { initI18n, resolveLanguage } from './i18n';
import { useLanguage } from './i18n/useLanguage';
import './theme/global.css';
import { useAppearance } from './theme/useAppearance';

// The texts are ready before anything is drawn. The setting is not known yet (Rust answers
// later), so the language starts as "system" read from the WebView, which follows Windows: no
// round trip before the first paint. `useLanguage` switches when the settings arrive.
initI18n(resolveLanguage('system', navigator.language));

/** The tokens, the appearance settings and the language are on the page before anything is drawn. */
function Root() {
  useAppearance();
  useLanguage();
  return <App />;
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
