import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './theme/global.css';
import { useAppearance } from './theme/useAppearance';

/** The tokens and the appearance settings are put on the page before anything is drawn. */
function Root() {
  useAppearance();
  return <App />;
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
