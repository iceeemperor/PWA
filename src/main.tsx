import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { requestPersistentStorage } from './data/persist';
import { Root } from './ui/App';
import './ui/styles.css';

// Ask the browser not to evict our storage (spec 8.3). Not awaited: rendering never waits for it.
void requestPersistentStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
