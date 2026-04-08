/**
 * Theme toggle component.
 *
 * Renders a button that switches between light and dark mode by toggling
 * the `data-theme` attribute on `<html>`. The user's preference is persisted
 * in `localStorage` under the key `"theme"`.
 *
 * @module components/theme-toggle
 */

const STORAGE_KEY = 'theme';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';

/**
 * Returns the stored theme preference, falling back to `"light"`.
 * @returns {'light' | 'dark'}
 */
function getStoredTheme() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === THEME_DARK) return THEME_DARK;
    return THEME_LIGHT;
}

/**
 * Apply a theme to the document and persist it.
 * @param {'light' | 'dark'} theme
 */
function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
}

/**
 * Update the button label to reflect the current theme.
 * Shows a sun when in dark mode (click to go light) and a moon when in
 * light mode (click to go dark).
 * @param {HTMLButtonElement} button
 * @param {'light' | 'dark'} currentTheme
 */
/** Inline SVG icon for the sun (shown in dark mode). */
const SUN_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

/** Inline SVG icon for the moon (shown in light mode). */
const MOON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function updateButtonLabel(button, currentTheme) {
    if (currentTheme === THEME_DARK) {
        button.innerHTML = SUN_SVG;
        button.setAttribute('aria-label', 'Switch to light mode');
        button.title = 'Switch to light mode';
    } else {
        button.innerHTML = MOON_SVG;
        button.setAttribute('aria-label', 'Switch to dark mode');
        button.title = 'Switch to dark mode';
    }
}

/**
 * Create a theme toggle button element.
 *
 * The button reads the initial theme from `localStorage` (defaulting to
 * `"light"`), applies it to `document.documentElement.dataset.theme`, and
 * toggles between light and dark on each click — persisting the choice.
 *
 * @returns {HTMLButtonElement} The toggle button, ready to be appended to the DOM.
 */
export function createThemeToggle() {
    const currentTheme = getStoredTheme();
    applyTheme(currentTheme);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-icon';
    updateButtonLabel(button, currentTheme);

    button.addEventListener('click', () => {
        const active = document.documentElement.dataset.theme === THEME_DARK
            ? THEME_LIGHT
            : THEME_DARK;
        applyTheme(active);
        updateButtonLabel(button, active);
    });

    return button;
}
