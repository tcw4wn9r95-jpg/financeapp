import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setLanguage } from './i18n';
import { Vault } from './storage/vault';
import { App } from './ui/App';
import { ToastProvider } from './ui/components/Toast';
import { VaultContext } from './ui/hooks';
import './styles.css';

setLanguage('en');
const vault = new Vault();

void vault.init().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <VaultContext.Provider value={vault}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </VaultContext.Provider>
    </StrictMode>,
  );
});

// Offline support: the service worker only exists in production builds.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js');
  });
}
