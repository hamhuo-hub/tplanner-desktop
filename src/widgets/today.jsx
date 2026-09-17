import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import TodayWidget from './TodayWidget.jsx';

// One React root per BrowserWindow: this page is a real renderer share of the design system,
// tokens and build pipeline, not a separate vanilla runtime. widget.html owns the stylesheets
// so the frameless window never paints before React mounts.
createRoot(document.getElementById('app')).render(
    <StrictMode>
        <TodayWidget />
    </StrictMode>,
);
