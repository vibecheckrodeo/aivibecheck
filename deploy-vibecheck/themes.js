// Archived serif palette sheet: the selected Butter identity plus eight alternatives.
// Changing a theme only updates presentation; it never reloads or replaces the form.
(() => {
  const themes = [
    { id: 'butter', name: 'Butter', crop: '1058 413 460 210', paper: '#fff2c9' },
    { id: 'ivory', name: 'Ivory', crop: '30 70 460 210', paper: '#fcf7e7' },
    { id: 'powder-blue', name: 'Powder blue', crop: '545 70 460 210', paper: '#e2effa' },
    { id: 'blush', name: 'Blush', crop: '1058 70 460 210', paper: '#f8e7ee' },
    { id: 'sage', name: 'Sage', crop: '30 413 460 210', paper: '#e4ecd8' },
    { id: 'lavender', name: 'Lavender', crop: '545 413 460 210', paper: '#ebe6f5' },
    { id: 'aqua', name: 'Aqua', crop: '30 753 460 210', paper: '#ddf0ee' },
    { id: 'sand', name: 'Sand', crop: '545 753 460 210', paper: '#efe6d8' },
    { id: 'pearl', name: 'Pearl', crop: '1058 753 460 210', paper: '#e8ecee' },
  ];
  const storageKey = 'vibecheck-brand-theme';
  const validTheme = id => themes.findIndex(theme => theme.id === id);
  let initial = 0;
  try {
    const saved = validTheme(localStorage.getItem(storageKey));
    if (saved >= 0) initial = saved;
  } catch { /* Appearance controls also work when browser storage is unavailable. */ }
  document.addEventListener('DOMContentLoaded', () => {
    const controls = document.getElementById('theme-controls');
    if (!controls) return;
    const label = document.getElementById('theme-current');
    const select = document.getElementById('theme-choice');
    const artwork = document.getElementById('brand-palette-art');
    const paletteImage = document.getElementById('brand-palette-image');
    const feedback = document.getElementById('theme-feedback');
    const meta = document.querySelector('meta[name="theme-color"]');
    let current = 0, requested = initial, selection = 0;
    let artworkReady = false, artworkLoad;
    themes.forEach(theme => select.add(new Option(theme.name, theme.id)));

    function apply(index, persist = true) {
      current = (index + themes.length) % themes.length;
      const theme = themes[current];
      label.textContent = `${current + 1} / ${themes.length} · ${theme.name}`;
      select.value = theme.id;
      artwork.setAttribute('viewBox', theme.crop);
      document.documentElement.dataset.theme = theme.id;
      meta?.setAttribute('content', theme.paper);
      if (persist) {
        try { localStorage.setItem(storageKey, theme.id); } catch {}
      }
    }

    function loadArtwork() {
      if (!artworkLoad) {
        // Leave the large alternate-logo sheet out of the default page request.
        // Wait for the displayed SVG image, not a separate preloaded image.
        artworkLoad = new Promise((resolve, reject) => {
          const cleanup = () => {
            paletteImage.removeEventListener('load', loaded);
            paletteImage.removeEventListener('error', failed);
          };
          const loaded = () => {
            cleanup();
            artworkReady = true;
            resolve();
          };
          const failed = () => {
            cleanup();
            paletteImage.removeAttribute('href');
            reject(new Error('Artwork unavailable'));
          };
          paletteImage.addEventListener('load', loaded);
          paletteImage.addEventListener('error', failed);
          paletteImage.setAttribute('href', '/brand/serif-palettes.webp');
        }).catch(error => {
          artworkLoad = undefined;
          throw error;
        });
      }
      return artworkLoad;
    }

    async function choose(index, persist = true) {
      requested = (index + themes.length) % themes.length;
      const next = requested, operation = ++selection;
      const theme = themes[next];
      select.value = theme.id;
      feedback.textContent = '';
      if (next !== 0 && !artworkReady) {
        feedback.textContent = `Loading ${theme.name} artwork…`;
        try { await loadArtwork(); }
        catch {
          if (operation !== selection) return;
          requested = current;
          select.value = themes[current].id;
          feedback.textContent = `The artwork couldn’t load. Showing ${themes[current].name}. Choose a style to try again.`;
          return;
        }
      }
      if (operation !== selection) return;
      apply(next, persist);
      feedback.textContent = '';
    }

    document.getElementById('theme-next').addEventListener('click', () => choose(requested + 1));
    document.getElementById('theme-previous').addEventListener('click', () => choose(requested - 1));
    select.addEventListener('change', () => {
      const index = validTheme(select.value);
      if (index >= 0) choose(index);
    });
    apply(0, false);
    controls.hidden = false;
    if (initial !== 0) choose(initial, false);
  });
})();
