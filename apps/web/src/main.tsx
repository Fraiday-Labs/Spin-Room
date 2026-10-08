import '@fontsource/pixelify-sans/latin-400.css';
import '@fontsource/vt323/latin-400.css';
import './styles/global.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalErrorReporting } from './lib/reportError';
import { queryClient } from './lib/api';

installGlobalErrorReporting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary
      where="app"
      fallback={(_retry, error) => (
        <div className="page stack" role="alert">
          <h1>Something went wrong</h1>
          <p className="muted">Spinroom hit an error and couldn’t show this page. Reloading usually fixes it; the error was reported.</p>
          <p className="muted">
            <code>{error.message}</code>
          </p>
          <div className="row">
            <button className="btn btn-primary" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      )}
    >
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
