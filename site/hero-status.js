(() => {
  const status = document.getElementById('hero-status');
  if (!status) return;

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
    status.classList.add('is-settled');
    status.setAttribute('aria-label', 'seeking help');
  });
})();
