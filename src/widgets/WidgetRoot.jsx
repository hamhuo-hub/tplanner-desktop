import { useWidgetWindow } from './useWidgetWindow.js';

/**
 * The window frame every sticky note shares: a draggable header, the scrolling body and a
 * footer. The window is frameless and transparent, so the drag/no-drag regions live in
 * shared-widget.css (`-webkit-app-region`) and depend on this rendering a real
 * <header>/<footer> pair around a single scrollable <main>.
 */
export default function WidgetRoot({ title, subtitle, bodyId, bodyLabel, stats, onRefresh, children }) {
    const { pinned, togglePin, openMain, hide } = useWidgetWindow();
    const pinLabel = pinned ? '取消始终置顶' : '始终置顶';

    return (
        <>
            <header>
                <div className="hdr-left">
                    <div className="hdr-date">{title}</div>
                    <div className="hdr-sub">{subtitle}</div>
                </div>
                <div className="hdr-right">
                    <button
                        type="button"
                        className={`icon-btn${pinned ? ' active' : ''}`}
                        title={pinLabel}
                        aria-label={pinLabel}
                        aria-pressed={pinned}
                        onClick={togglePin}
                    >↴</button>
                    <button type="button" className="icon-btn" title="打开 tPlanner" aria-label="打开 tPlanner" onClick={openMain}>↗</button>
                    <button type="button" className="icon-btn danger" title="关闭便签" aria-label="关闭便签" onClick={hide}>✕</button>
                </div>
            </header>
            <main id={bodyId} aria-label={bodyLabel}>{children}</main>
            <footer>
                <div className="stats">{stats}</div>
                <div className="actions"><button type="button" className="link-btn" onClick={onRefresh}>↻ 刷新</button></div>
            </footer>
        </>
    );
}
