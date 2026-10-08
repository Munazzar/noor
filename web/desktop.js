/* Big screens: the tab bar is a vertical side bar, so its sliding "lens" moves up and down. */
(function () {
  const wide = matchMedia('(min-width: 1024px)');
  const orig = window.placeLens;
  if (typeof orig !== 'function') return;
  window.placeLens = function (container, btn) {
    if (container && container.id === 'tabbar') {
      const lens = container.querySelector('.lens');
      if (lens && btn && wide.matches) {
        lens.style.left = btn.offsetLeft + 'px'; lens.style.width = btn.offsetWidth + 'px';
        lens.style.top = btn.offsetTop + 'px'; lens.style.height = btn.offsetHeight + 'px'; lens.style.bottom = 'auto';
        return;
      }
      if (lens) { lens.style.top = ''; lens.style.height = ''; lens.style.bottom = ''; }
    }
    return orig(container, btn);
  };
  const bar = document.getElementById('tabbar');
  if (bar && !bar.querySelector('.side-logo')) { const l = document.createElement('div'); l.className = 'side-logo'; l.setAttribute('aria-hidden', 'true'); const lens = bar.querySelector('.lens'); bar.insertBefore(l, lens ? lens.nextSibling : bar.firstChild); }
  const sync = () => { const t = document.getElementById('tabbar'); if (t) window.placeLens(t, t.querySelector('button.on')); };
  wide.addEventListener('change', sync);
  requestAnimationFrame(sync);
})();
