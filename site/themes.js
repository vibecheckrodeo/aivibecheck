// The four shortlisted identities. Archived sheets retain the original artwork.
// Changing a theme only updates presentation; it never reloads or replaces the form.
(() => {
  const sheets = {
    expressive: '/brand/four-eye-serif-wave-conversation-options.png',
    typographic: '/brand/four-serious-typographic-options.png',
  };
  const themes = [
    { id: 'butter', name: 'Butter', paper: '#fff2c9' },
    { id: 'geometric', name: 'Geometric', sheet: 'typographic', crop: '55 185 665 125', paper: '#e8ebe8' },
    { id: 'ribbon', name: 'Ribbon', sheet: 'expressive', crop: '20 615 735 305', paper: '#fff7d9' },
    { id: 'expressive-serif', name: 'Expressive serif', sheet: 'expressive', crop: '810 105 700 300', paper: '#ffe1dc' },
  ];
  const storageKey = 'vibecheck-brand-theme';
  const validTheme = id => themes.findIndex(theme => theme.id === id);
  let previous = -1;
  try {
    previous = validTheme(localStorage.getItem(storageKey));
  } catch { /* Appearance controls also work when browser storage is unavailable. */ }
  const queryTheme = new URLSearchParams(location.search).get('theme');
  // A theme written by an ordinary visit may rotate again on refresh. A copied
  // link has no such history state, so the recipient gets the advertised theme.
  const automatic = history.state?.vibecheckTheme?.automatic === true && history.state.vibecheckTheme.id === queryTheme;
  const pinned = automatic ? -1 : validTheme(queryTheme);
  const candidates = themes.map((theme, index) => index).filter(index => index !== previous);
  // A fixed ad link overrides visit rotation. Without stored state, every theme
  // is eligible; no-repeat behavior across visits is necessarily best-effort.
  const initial = pinned >= 0 ? pinned : candidates[Math.floor(Math.random() * candidates.length)];
  document.addEventListener('DOMContentLoaded', () => {
    const hint = document.getElementById('theme-hint');
    if (!hint) return;
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

    function apply(index, persist = true, rotateOnRefresh = false) {
      current = (index + themes.length) % themes.length;
      const theme = themes[current];
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
        syncUrl(theme.id, rotateOnRefresh);
      }
    }

    function syncUrl(id, automatic) {
      const url = new URL(location.href);
      url.searchParams.delete('theme');
      url.searchParams.append('theme', id);
      try {
        history.replaceState({ ...history.state, vibecheckTheme: { id, automatic } }, '', url.href);
      } catch { /* A restricted browser must still display the selected style. */ }
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

    async function choose(index, rotateOnRefresh = false) {
      requested = (index + themes.length) % themes.length;
      const next = requested, operation = ++selection;
      const theme = themes[next];
      feedback.textContent = '';
      if (theme.sheet && !artworkSheets.get(theme.sheet)?.ready) {
        feedback.textContent = `Loading ${theme.name} artwork…`;
        try { await loadArtwork(theme.sheet); }
        catch {
          if (operation !== selection) return;
          requested = current;
          syncUrl(themes[current].id, rotateOnRefresh);
          feedback.textContent = `The artwork couldn’t load. Showing ${themes[current].name}. Press Control, Shift and K to try another style.`;
          return;
        }
      }
      if (operation !== selection) return;
      apply(next, true, rotateOnRefresh);
      feedback.textContent = `${theme.name} style.`;
    }

    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || typeof event.key !== 'string' || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      // Update the shareable URL in place without navigating or replacing forms.
      choose(requested + 1);
    });
    apply(0, false);
    hint.hidden = false;
    choose(initial, pinned < 0);
  });
})();
