// Approved Butter identity plus the last three archived four-direction sheets.
// Changing a theme only updates presentation; it never reloads or replaces the form.
(() => {
  const sheets = {
    expressive: '/brand/four-eye-serif-wave-conversation-options.png',
    cleanup: '/brand/four-slop-cleanup-options.png',
    typographic: '/brand/four-serious-typographic-options.png',
  };
  const themes = [
    { id: 'butter', name: 'Butter', paper: '#fff2c9' },
    { id: 'eye', name: 'Eye', sheet: 'expressive', crop: '45 100 680 310', paper: '#fffefd' },
    { id: 'expressive-serif', name: 'Expressive serif', sheet: 'expressive', crop: '810 105 700 300', paper: '#fffefd' },
    { id: 'ribbon', name: 'Ribbon', sheet: 'expressive', crop: '20 615 735 305', paper: '#fffefd' },
    { id: 'conversation', name: 'Conversation', sheet: 'expressive', crop: '810 620 700 300', paper: '#fffefd' },
    { id: 'splash-check', name: 'Splash check', sheet: 'cleanup', crop: '30 58 710 387', clip: 'M30 58H740V375H345V445H30Z', paper: '#fffcf2' },
    { id: 'melting-type', name: 'Melting type', sheet: 'cleanup', crop: '790 145 730 225', paper: '#fffcf2' },
    { id: 'peel-back', name: 'Peel back', sheet: 'cleanup', crop: '30 550 710 405', clip: 'M80 550H740V890H325V955H30V580H80Z', paper: '#fffcf2' },
    { id: 'sifted-slop', name: 'Sifted slop', sheet: 'cleanup', crop: '790 590 720 315', paper: '#fffcf2' },
    { id: 'geometric', name: 'Geometric', sheet: 'typographic', crop: '55 185 665 125', paper: '#fffefd' },
    { id: 'editorial', name: 'Editorial', sheet: 'typographic', crop: '810 180 700 135', paper: '#fffefd' },
    { id: 'condensed', name: 'Condensed', sheet: 'typographic', crop: '170 575 425 350', paper: '#fffefd' },
    { id: 'humanist', name: 'Humanist', sheet: 'typographic', crop: '810 680 700 145', paper: '#fffefd' },
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
    const namespace = 'http://www.w3.org/2000/svg';
    const artworkSheets = new Map();
    const definitions = document.createElementNS(namespace, 'defs');
    const clip = document.createElementNS(namespace, 'clipPath');
    const clipShape = document.createElementNS(namespace, 'path');
    clip.setAttribute('id', 'brand-artwork-crop');
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    clip.appendChild(clipShape);
    definitions.appendChild(clip);
    artwork.appendChild(definitions);
    paletteImage.setAttribute('opacity', '0');
    themes.forEach(theme => select.add(new Option(theme.name, theme.id)));

    function apply(index, persist = true) {
      current = (index + themes.length) % themes.length;
      const theme = themes[current];
      label.textContent = `${current + 1} / ${themes.length} · ${theme.name}`;
      select.value = theme.id;
      if (theme.sheet) {
        artwork.setAttribute('viewBox', theme.crop);
        const [x, y, width, height] = theme.crop.split(' ').map(Number);
        // Clip the crop itself, not just the outer SVG viewport: letterboxing
        // must not expose sheet option numbers, dividers or embedded slogans.
        clipShape.setAttribute('d', theme.clip || `M${x} ${y}h${width}v${height}h-${width}Z`);
      }
      for (const [sheet, record] of artworkSheets) record.node.setAttribute('opacity', sheet === theme.sheet ? '1' : '0');
      document.documentElement.dataset.theme = theme.id;
      meta?.setAttribute('content', theme.paper);
      if (persist) {
        try { localStorage.setItem(storageKey, theme.id); } catch {}
      }
    }

    function loadArtwork(sheet) {
      let record = artworkSheets.get(sheet);
      if (!record) {
        // Each sheet has its own image. Never replace the currently visible
        // image's href while another sheet is loading or has failed.
        const node = artworkSheets.size ? document.createElementNS(namespace, 'image') : paletteImage;
        node.setAttribute('width', '1536');
        node.setAttribute('height', '1024');
        node.setAttribute('opacity', '0');
        node.setAttribute('clip-path', 'url(#brand-artwork-crop)');
        if (node !== paletteImage) artwork.appendChild(node);
        record = { node, ready: false, promise: undefined };
        artworkSheets.set(sheet, record);
      }
      if (!record.promise) {
        // Only request a selected sheet; its actual SVG load event gates use.
        const { node } = record;
        record.promise = new Promise((resolve, reject) => {
          const cleanup = () => {
            node.removeEventListener('load', loaded);
            node.removeEventListener('error', failed);
          };
          const loaded = () => {
            cleanup();
            record.ready = true;
            resolve();
          };
          const failed = () => {
            cleanup();
            node.removeAttribute('href');
            reject(new Error('Artwork unavailable'));
          };
          node.addEventListener('load', loaded);
          node.addEventListener('error', failed);
          node.setAttribute('href', sheets[sheet]);
        }).catch(error => {
          record.promise = undefined;
          throw error;
        });
      }
      return record.promise;
    }

    async function choose(index, persist = true) {
      requested = (index + themes.length) % themes.length;
      const next = requested, operation = ++selection;
      const theme = themes[next];
      select.value = theme.id;
      feedback.textContent = '';
      if (theme.sheet && !artworkSheets.get(theme.sheet)?.ready) {
        feedback.textContent = `Loading ${theme.name} artwork…`;
        try { await loadArtwork(theme.sheet); }
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
