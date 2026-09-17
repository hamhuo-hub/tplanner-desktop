import { useCallback, useEffect, useState } from 'react';

/** The preload bridge for this window, or undefined when the preload did not load. */
export function widgetApi() {
    return typeof window === 'undefined' ? undefined : window.widgetAPI;
}

/**
 * Window chrome shared by every sticky-note renderer: always-on-top, open main, hide.
 *
 * Replaces initializeWindowControls() from the retired widget-shared.mjs. The pin state is
 * read from main once and afterwards only ever reflects what main reports back — the window
 * never assumes a toggle applied.
 */
export function useWidgetWindow() {
    const api = widgetApi();
    const [pinned, setPinned] = useState(false);

    useEffect(() => {
        if (!api) return undefined;
        let live = true;
        api.isAlwaysOnTop()
            .then((on) => { if (live) setPinned(Boolean(on)); })
            .catch(() => { /* keep the safe default: not pinned */ });
        return () => { live = false; };
    }, [api]);

    const togglePin = useCallback(() => {
        if (!api) return;
        api.toggleAlwaysOnTop()
            .then((on) => setPinned(Boolean(on)))
            .catch(() => { /* main owns the real state; a failed toggle changes nothing */ });
    }, [api]);

    const openMain = useCallback(() => { api?.openMain(); }, [api]);
    const hide = useCallback(() => { api?.close(); }, [api]);

    return { api, pinned, togglePin, openMain, hide };
}
