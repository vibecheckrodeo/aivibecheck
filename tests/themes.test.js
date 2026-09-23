import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../site/themes.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../site/themes.css', import.meta.url), 'utf8');
const sharedCss = await readFile(new URL('../site/site.css', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const styles = ['butter', 'geometric', 'ribbon', 'expressive-serif'];

function page({ saved, blockedStorage = false, blockedWrite = false, query = '', random = 0, historyState = null, hash = '', blockedHistory = false } = {}) {
  const nodes = new Map(), created = [], loads = [], writes = [], events = {};
  const root = { dataset: {} };
  let stored = saved;
  const makeNode = (tag, id) => ({
    tag, id, hidden: true, textContent: '', attrs: {}, handlers: {}, children: [],
    setAttribute(key, value) {
      this.attrs[key] = value;
      if (tag === 'image' && key === 'href') {
        assert.equal(typeof this.handlers.load, 'function', 'Attach load handler before assigning artwork');
        assert.equal(typeof this.handlers.error, 'function', 'Attach error handler before assigning artwork');
        loads.push({ url: value, node: this, resolve: () => this.handlers.load?.(), reject: () => this.handlers.error?.() });
      }
    },
    removeAttribute(key) { delete this.attrs[key]; },
    removeEventListener(event, callback) { if (this.handlers[event] === callback) delete this.handlers[event]; },
    addEventListener(event, callback) { this.handlers[event] = callback; },
    appendChild(child) { this.children.push(child); return child; },
  });
  for (const id of ['theme-hint', 'brand-palette-art', 'brand-palette-image', 'theme-feedback']) {
    nodes.set(id, makeNode(id === 'brand-palette-image' ? 'image' : 'div', id));
  }
  nodes.get('brand-palette-art').appendChild(nodes.get('brand-palette-image'));
  const address = { search: query, href: `https://vibecheck.test/${query}${hash}`, reload() { assert.fail('Theme changes must not reload'); }, assign() { assert.fail('Theme changes must not navigate'); } };
  const location = new Proxy(address, { set() { assert.fail('Use History API without navigating'); } });
  const history = { state: historyState, replaceState(state, title, href) { if (blockedHistory) throw Error('history unavailable'); this.state = state; const url = new URL(href); address.href = url.href; address.search = url.search; } };
  const controlledMath = Object.create(Math);
  controlledMath.random = typeof random === 'function' ? random : () => random;
  runInNewContext(source, {
    Math: controlledMath, URL, URLSearchParams, location, history,
    localStorage: {
      getItem(key) { assert.equal(key, 'vibecheck-brand-theme'); if (blockedStorage) throw Error('storage unavailable'); return stored; },
      setItem(key, value) { if (blockedStorage || blockedWrite) throw Error('storage unavailable'); writes.push({ key, value }); stored = value; },
    },
    document: {
      documentElement: root,
      getElementById(id) { assert.ok(nodes.has(id), `Unexpected access outside theme presentation: ${id}`); return nodes.get(id); },
      createElementNS(namespace, tag) {
        assert.equal(namespace, 'http://www.w3.org/2000/svg');
        assert.ok(['defs', 'clipPath', 'path', 'image'].includes(tag));
        const node = makeNode(tag); created.push(node); return node;
      },
      querySelector(selector) { assert.equal(selector, 'meta[name="theme-color"]'); return { setAttribute() {} }; },
      addEventListener(event, callback) { assert.ok(['DOMContentLoaded', 'keydown'].includes(event)); events[event] = callback; },
    },
  });
  events.DOMContentLoaded();
  const key = (overrides = {}) => {
    let prevented = false;
    const event = { key: 'K', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false, isComposing: false, defaultPrevented: false, preventDefault() { prevented = true; }, ...overrides };
    events.keydown(event);
    return prevented;
  };
  return {
    root, loads, writes, created, key, location, history,
    stored: () => stored,
    node: id => nodes.get(id),
    active: () => [nodes.get('brand-palette-image'), ...created.filter(node => node.tag === 'image')].filter(node => node.attrs.opacity === '1'),
    clip: () => created.find(node => node.tag === 'path').attrs.d,
    advance(count = 1) { for (let i = 0; i < count; i++) assert.equal(key(), true); },
    async finishLoads() { for (const load of loads) load.resolve(); await settle(); },
  };
}

test('no visible switcher remains; an empty live region and discreet shortcut hint remain', () => {
  assert.doesNotMatch(html, /id="theme-(?:controls|current|choice|previous|next)"/);
  assert.doesNotMatch(html, /<image\b[^>]*\bhref=/i);
  assert.match(html, /<p id="theme-feedback"[^>]*role="status"[^>]*><\/p>/);
  assert.doesNotMatch(html, /<p id="theme-feedback"[^>]*\shidden(?:\s|>)/);
  assert.match(html, /id="theme-hint"[^>]*hidden>Change the look: <kbd>Ctrl<\/kbd> \+ <kbd>Shift<\/kbd> \+ <kbd>K<\/kbd>/);
  const p = page({ query: '?theme=butter' });
  assert.equal(p.loads.length, 0); assert.equal(p.node('theme-hint').hidden, false);
  assert.equal(p.root.dataset.theme, 'butter');
});

test('public copy avoids fake window chrome and internal implementation details', () => {
  assert.doesNotMatch(html, /hero-signal|signal-canvas|signal-node/);
  assert.doesNotMatch(sharedCss, /content:\s*["']×["']/);
  assert.doesNotMatch(sharedCss, /content:\s*["']ABOUT \/ ASHLEY["']/);
  assert.doesNotMatch(sharedCss, /content:\s*["']STEP 0["']/);
  assert.doesNotMatch(html, /TypeSafe|System One|Jev/i);
});

test('the hero portrait is real content with restrained accessible motion', () => {
  assert.match(html, /class="portrait-frame"><img src="\/ashley-portrait\.png" width="460" height="460" alt="Ashley Raiteri"/);
  assert.match(sharedCss, /@keyframes portrait-orbit/);
  assert.match(sharedCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.portrait-track \{ animation: none; \}/);
  for (const id of styles.slice(1)) assert.match(css, new RegExp(`data-theme="${id}"\\] \\.portrait-`));
});

test('normal visits exclude every valid last style at both random boundaries and in between', async () => {
  for (const saved of styles) {
    for (const random of [0, .1, .55, .999999]) {
      const p = page({ saved, random });
      await p.finishLoads();
      assert.notEqual(p.root.dataset.theme, saved, `Repeated ${saved} for sample ${random}`);
      assert.ok(styles.includes(p.root.dataset.theme));
      assert.equal(p.stored(), p.root.dataset.theme);
      assert.equal(p.writes.length, 1);
    }
  }
});

test('successive normal refreshes use the most recently visible style as their exclusion', async () => {
  let saved;
  for (let visit = 0; visit < 12; visit++) {
    const p = page({ saved, random: .31 });
    await p.finishLoads();
    assert.notEqual(p.root.dataset.theme, saved);
    saved = p.stored();
  }
});

test('initial random artwork does not commit the temporary Butter fallback or the pending choice', async () => {
  const p = page({ saved: 'butter', random: 0 });
  assert.equal(p.loads.length, 1); assert.equal(p.root.dataset.theme, 'butter');
  assert.equal(p.stored(), 'butter'); assert.equal(p.writes.length, 0);
  assert.match(p.node('theme-feedback').textContent, /Loading Geometric/);
  p.loads[0].resolve(); await settle();
  assert.equal(p.root.dataset.theme, 'geometric'); assert.equal(p.stored(), 'geometric');
  assert.deepEqual(p.writes.map(item => item.value), ['geometric']);
});

test('failed initial artwork preserves last-visit state and allows the shortcut to retry', async () => {
  const p = page({ saved: 'butter', random: 0 });
  const image = p.loads[0].node;
  p.loads[0].reject(); await settle();
  assert.equal(p.root.dataset.theme, 'butter'); assert.equal(p.writes.length, 0);
  assert.equal(p.stored(), 'butter'); assert.equal(image.attrs.href, undefined);
  assert.match(p.node('theme-feedback').textContent, /Showing Butter/);
  p.advance(); assert.equal(p.loads.length, 2); assert.equal(p.loads[1].node, image);
  p.loads[1].resolve(); await settle();
  assert.equal(p.root.dataset.theme, 'geometric'); assert.equal(p.stored(), 'geometric');
});

test('missing, obsolete and inaccessible storage use a random fallback, with write failures tolerated', async () => {
  for (const options of [{}, { saved: 'sage' }, { saved: 'unknown' }, { saved: 'peel-back', blockedStorage: true }]) {
    const p = page({ ...options, random: .6 });
    await p.finishLoads();
    assert.equal(p.root.dataset.theme, 'ribbon');
    assert.equal(p.node('theme-feedback').textContent, 'Ribbon style.');
  }
  const blockedWrite = page({ saved: 'geometric', random: 0, blockedWrite: true });
  assert.equal(blockedWrite.root.dataset.theme, 'butter'); assert.equal(blockedWrite.writes.length, 0);
  assert.equal(blockedWrite.stored(), 'geometric');
});

test('every valid pinned landing ignores random selection and remains pinned on refresh', async () => {
  for (const id of styles) {
    const query = `?utm_source=linkedin&campaign=fixture&theme=${id}`;
    const p = page({ saved: id, query, random: () => assert.fail('Pinned links must not randomize') });
    await p.finishLoads();
    assert.equal(p.root.dataset.theme, id); assert.equal(p.stored(), id);
    const refreshed = page({ saved: p.stored(), query, random: () => assert.fail('Pinned refresh must not randomize') });
    await refreshed.finishLoads();
    assert.equal(refreshed.root.dataset.theme, id); assert.equal(refreshed.location.search, query);
  }
});

test('empty and invalid pinned values use normal no-repeat selection without echoing query content', async () => {
  for (const query of ['?theme=', '?theme=unknown', '?theme=EYE', '?theme=%3Cscript%3E', '?utm_source=linkedin']) {
    const p = page({ saved: 'butter', query, random: 0 });
    await p.finishLoads();
    assert.equal(p.root.dataset.theme, 'geometric'); assert.equal(p.stored(), 'geometric');
    assert.equal(p.node('theme-feedback').textContent, 'Geometric style.');
    assert.equal(new URLSearchParams(p.location.search).get('theme'), p.root.dataset.theme);
  }
});

test('only exact Ctrl+Shift+K rotates, case insensitively, without repeat or composition interference', async () => {
  const p = page({ query: '?theme=butter' });
  for (const event of [{ ctrlKey: false }, { shiftKey: false }, { altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { key: 'j' }, { key: 'Unidentified' }, { key: undefined }]) {
    assert.equal(p.key(event), false);
  }
  assert.equal(p.loads.length, 0); assert.equal(p.root.dataset.theme, 'butter');
  assert.equal(p.key({ key: 'k' }), true);
  p.loads[0].resolve(); await settle(); assert.equal(p.root.dataset.theme, 'geometric');
  assert.equal(p.key({ key: 'K' }), true); await p.finishLoads(); assert.equal(p.root.dataset.theme, 'ribbon');
  assert.equal(p.location.search, '?theme=ribbon');
});

test('keyboard rotation visits only the four shortlisted styles and keeps other URL data intact', async () => {
  const p = page({ query: '?theme=butter&utm_source=linkedin&request=fixture', hash: '#access=synthetic', historyState: { retained: 1 } });
  for (const style of [...styles.slice(1), 'butter']) {
    p.advance(); await p.finishLoads();
    assert.equal(p.root.dataset.theme, style);
    assert.equal(p.location.search, `?utm_source=linkedin&request=fixture&theme=${style}`);
    assert.equal(new URL(p.location.href).hash, '#access=synthetic');
    assert.equal(p.history.state.retained, 1);
    assert.equal(p.history.state.vibecheckTheme.automatic, false);
    if (style !== 'butter') { assert.equal(p.active().length, 1); assert.ok(p.clip()); }
  }
  assert.deepEqual(p.loads.map(load => load.url), [
    '/brand/four-serious-typographic-options.png',
    '/brand/four-eye-serif-wave-conversation-options.png',
    '/brand/expressive-serif-clean-k.png',
  ]);
  assert.equal(p.active().length, 0);
});

test('automatic visits write a shareable URL but still rotate on refresh; copied URLs stay pinned', async () => {
  const first = page({ saved: 'butter', query: '?utm_source=linkedin', random: 0 });
  await first.finishLoads();
  assert.equal(first.location.search, '?utm_source=linkedin&theme=geometric');
  const refreshed = page({ saved: first.stored(), query: first.location.search, historyState: first.history.state, random: 0 });
  await refreshed.finishLoads();
  assert.equal(refreshed.root.dataset.theme, 'butter');
  const copied = page({ saved: first.stored(), query: first.location.search, random: () => assert.fail('A copied URL must pin its style') });
  await copied.finishLoads();
  assert.equal(copied.root.dataset.theme, 'geometric');
  assert.equal(copied.history.state.vibecheckTheme.automatic, false);
});

test('rapid cross-sheet choices and failures only commit the latest successful style and URL', async () => {
  for (const lateFailure of [false, true]) {
    const p = page({ query: '?theme=geometric' });
    p.advance(2);
    assert.equal(p.loads.length, 3); assert.equal(p.writes.length, 0);
    p.loads[2].resolve(); await settle();
    if (lateFailure) p.loads[1].reject(); else p.loads[1].resolve();
    p.loads[0].resolve();
    await settle();
    assert.equal(p.root.dataset.theme, 'expressive-serif');
    assert.equal(p.location.search, '?theme=expressive-serif');
    assert.deepEqual(p.writes.map(item => item.value), ['expressive-serif']);
  }
});

test('cross-sheet failure preserves displayed artwork and URL, then retries the failed node', async () => {
  const p = page({ query: '?theme=geometric' });
  await p.finishLoads();
  const current = p.active()[0], crop = p.node('brand-palette-art').attrs.viewBox;
  p.advance(); const failedImage = p.loads[1].node;
  assert.equal(p.active()[0], current); assert.equal(p.node('brand-palette-art').attrs.viewBox, crop);
  assert.equal(p.location.search, '?theme=geometric');
  p.loads[1].reject(); await settle();
  assert.equal(p.root.dataset.theme, 'geometric'); assert.equal(p.stored(), 'geometric');
  assert.equal(p.location.search, '?theme=geometric');
  p.advance(); assert.equal(p.loads[2].node, failedImage);
  p.loads[2].resolve(); await settle();
  assert.equal(p.root.dataset.theme, 'ribbon'); assert.equal(p.location.search, '?theme=ribbon');
});

test('wrapping to Butter cancels pending artwork without stale URL changes', async () => {
  for (const fail of [false, true]) {
    const p = page({ query: '?theme=expressive-serif' });
    p.advance();
    if (fail) p.loads[0].reject(); else p.loads[0].resolve();
    await settle();
    assert.equal(p.root.dataset.theme, 'butter'); assert.equal(p.active().length, 0);
    assert.equal(p.location.search, '?theme=butter');
    assert.deepEqual(p.writes.map(item => item.value), ['butter']);
  }
});

test('restricted history does not stop theme selection', async () => {
  const p = page({ blockedHistory: true, query: '?theme=butter' });
  p.advance(); await p.finishLoads();
  assert.equal(p.root.dataset.theme, 'geometric');
});

test('all alternate palettes retain readable text contrast and an explicit heading family', () => {
  const luminance = hex => {
    const channels = hex.match(/[\da-f]{2}/gi).map(value => Number.parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  for (const id of styles.slice(1)) {
    const rule = css.match(new RegExp(`:root\\[data-theme="${id}"\\] \\{([^}]+)\\}`))?.[1];
    assert.ok(rule, `Missing direction ${id}`);
    const ink = rule.match(/--ink: (#[\da-f]{6})/)?.[1], paper = rule.match(/--paper: (#[\da-f]{6})/)?.[1];
    assert.ok(ink && paper); assert.match(rule, /--brand-heading:/);
    const ratio = (luminance(paper) + .05) / (luminance(ink) + .05);
    assert.ok(ratio >= 4.5, `${id} text contrast is ${ratio}`);
  }
});

test('each named direction has its own structural treatment, not only a palette swap', () => {
  assert.match(css, /data-theme="butter"\] \.agent-response/);
  assert.match(css, /data-theme="geometric"\] \.process li::before/);
  assert.match(css, /data-theme="ribbon"\] \.process ol/);
  assert.match(css, /data-theme="expressive-serif"\] \.process ol/);
});
