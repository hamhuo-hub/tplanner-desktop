/**
 * 在第三方库初始化之前拦截 console，过滤掉已知的广告/噪音日志。
 * 必须在 main.tsx 最顶部导入。
 */

const NOISE_PATTERNS = [
    // i18next 广告
    /i18next is made possible by our own product/,
    /locize\.com/,
    // Dexie 免费版提示（V5 只用原生 Dexie，没有 RxDB 层）
    /free Dexie\.js/,
    // aria-hidden 浏览器警告（来自 MUI Modal）
    /Blocked aria-hidden on an element/,
];

function isSuppressed(...args) {
    const msg = args.map(a => (typeof a === 'string' ? a : '')).join(' ');
    return NOISE_PATTERNS.some(p => p.test(msg));
}

(['log', 'info', 'warn'] ).forEach(level => {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
        if (!isSuppressed(...args)) orig(...args);
    };
});
