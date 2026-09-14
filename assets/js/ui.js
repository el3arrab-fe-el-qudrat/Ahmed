/**
 * Shared chrome: theme toggle and the mobile navigation menu.
 * Loaded by every page. The initial theme is applied by a tiny blocking script
 * in <head> so the page never flashes the wrong palette.
 */

const THEME_KEY = 'arrab-qudurat:theme';

/** Light unless the visitor has explicitly switched to dark. The OS setting is ignored. */
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Point the toggle at whatever switching would do next. Never writes state. */
function syncThemeButton(button) {
  if (!button) return;
  const toDark = currentTheme() === 'light';
  button.setAttribute('aria-label', toDark ? 'تفعيل الوضع الداكن' : 'تفعيل الوضع الفاتح');
  button.setAttribute('title', toDark ? 'الوضع الداكن' : 'الوضع الفاتح');
  button.querySelector('use')?.setAttribute('href', toDark ? '#i-moon' : '#i-sun');
}

/** Only ever called from the toggle: this is the one place that persists. */
function setTheme(theme, button) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable - the choice simply will not persist */
  }
  syncThemeButton(button);
}

function initTheme() {
  const button = document.getElementById('themeToggle');
  if (!button) return;

  syncThemeButton(button);

  button.addEventListener('click', () => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark', button);
  });
}

function initNav() {
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('primaryNav');
  if (!toggle || !nav) return;

  const desktop = window.matchMedia('(min-width: 720px)');

  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'إغلاق قائمة التنقل' : 'فتح قائمة التنقل');
    nav.classList.toggle('nav--open', open);
    toggle.querySelector('use')?.setAttribute('href', open ? '#i-close' : '#i-menu');
  };

  setOpen(false);

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a') && !desktop.matches) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (desktop.matches || toggle.getAttribute('aria-expanded') !== 'true') return;
    if (!nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });

  desktop.addEventListener('change', () => setOpen(false));
}

initTheme();
initNav();
