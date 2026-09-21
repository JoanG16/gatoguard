(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const navigationDuration = 180;

  document.documentElement.classList.add('gg-motion-ready');
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('gg-app-view');
  }, { once: true });

  window.ggViewTransition = callback => {
    if (!reduceMotion.matches && typeof document.startViewTransition === 'function') {
      return document.startViewTransition(callback).finished;
    }
    return Promise.resolve(callback());
  };

  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download') || link.origin !== location.origin) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const destination = new URL(link.href);
    if (destination.pathname === location.pathname && destination.search === location.search) return;

    if (!reduceMotion.matches && typeof document.startViewTransition === 'function') {
      event.preventDefault();
      document.startViewTransition(() => { location.href = link.href; });
      return;
    }

    if (reduceMotion.matches) return;
    event.preventDefault();
    document.body.classList.add('gg-app-view-leaving');
    window.setTimeout(() => { location.href = link.href; }, navigationDuration);
  });
})();
