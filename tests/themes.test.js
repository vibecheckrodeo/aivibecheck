import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../site/themes.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../site/themes.css', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const styles = ['butter', 'eye', 'expressive-serif', 'ribbon', 'conversation', 'splash-check', 'melting-type', 'peel-back', 'sifted-slop', 'geometric', 'editorial', 'condensed', 'humanist'];

function page({ saved, blockedStorage = false } = {}) {
  const nodes = new Map(), created = [], loads = [], writes = [];
  const root = { dataset: {} };
  const makeNode = (tag, id) => ({
    tag, id, hidden: true, value: '', textContent: '', attrs: {}, handlers: {}, options: [], children: [],
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
    add(option) { this.options.push(option); },
    addEventListener(event, callback) { this.handlers[event] = callback; },
    appendChild(child) { this.children.push(child); return child; },
  });
  for (const id of ['theme-controls', 'theme-current', 'theme-choice', 'brand-palette-art', 'brand-palette-image', 'theme-feedback', 'theme-next', 'theme-previous']) {
    nodes.set(id, makeNode(id === 'brand-palette-image' ? 'image' : 'div', id));
  }
  nodes.get('brand-palette-art').appendChild(nodes.get('brand-palette-image'));
  let ready;
  runInNewContext(source, {
    Option: function(text, value) { this.text = text; this.value = value; },
    localStorage: {
      getItem() { if (blockedStorage) throw Error('storage unavailable'); return saved; },
      setItem(key, value) { if (blockedStorage) throw Error('storage unavailable'); writes.push({ key, value }); },
    },
    document: {
      documentElement: root,
      getElementById(id) { assert.ok(nodes.has(id), `Unexpected access outside theme controls: ${id}`); return nodes.get(id); },
      createElementNS(namespace, tag) {
        assert.equal(namespace, 'http://www.w3.org/2000/svg');
        assert.ok(['defs', 'clipPath', 'path', 'image'].includes(tag));
        const node = makeNode(tag); created.push(node); return node;
      },
      querySelector(selector) { assert.equal(selector, 'meta[name="theme-color"]'); return { setAttribute() {} }; },
      addEventListener(event, callback) { assert.equal(event, 'DOMContentLoaded'); ready = callback; },
    },
  });
  ready();
  return {
    root, loads, writes, created,
    node: id => nodes.get(id),
    active: () => [nodes.get('brand-palette-image'), ...created.filter(node => node.tag === 'image')].filter(node => node.attrs.opacity === '1'),
    clip: () => created.find(node => node.tag === 'path').attrs.d,
    click: id => nodes.get(id).handlers.click(),
    pick(id) { const select = nodes.get('theme-choice'); select.value = id; select.handlers.change(); },
  };
}

test('Butter, invalid and obsolete saved styles request no artwork and expose 13 distinct directions', () => {
  assert.doesNotMatch(html, /<image\b[^>]*\bhref=/i);
  assert.match(html, /<p id="theme-feedback"[^>]*role="status"[^>]*><\/p>/);
  assert.doesNotMatch(html, /<p id="theme-feedback"[^>]*hidden/);
  for (const options of [{}, { saved: 'unknown' }, { saved: 'sage' }, { blockedStorage: true }]) {
    const p = page(options);
    assert.equal(p.loads.length, 0);
    assert.equal(p.root.dataset.theme, 'butter');
    assert.equal(p.node('theme-controls').hidden, false);
    assert.deepEqual(p.node('theme-choice').options.map(option => option.value), styles);
    assert.equal(p.node('theme-current').textContent, '1 / 13 · Butter');
    assert.equal(p.writes.length, 0);
  }
});

test('all 13 directions wrap in both directions and reuse only their three needed sheets', async () => {
  const p = page();
  for (const style of styles.slice(1)) {
    const oldStyle = p.root.dataset.theme, count = p.loads.length;
    const pending = p.click('theme-next');
    if (p.loads.length > count) {
      assert.equal(p.root.dataset.theme, oldStyle);
      p.loads.at(-1).resolve();
    }
    await pending;
    assert.equal(p.root.dataset.theme, style);
    assert.equal(p.active().length, 1);
    assert.equal(p.active()[0].attrs['clip-path'], 'url(#brand-artwork-crop)');
    assert.ok(p.clip());
    assert.equal(p.node('theme-feedback').textContent, '');
  }
  assert.equal(p.loads.length, 3);
  assert.equal(p.created.filter(node => node.tag === 'image').length, 2);
  await p.click('theme-next');
  assert.equal(p.root.dataset.theme, 'butter'); assert.equal(p.active().length, 0);
  await p.click('theme-previous');
  assert.equal(p.root.dataset.theme, 'humanist'); assert.equal(p.loads.length, 3);
  for (const load of p.loads) assert.deepEqual(load.node.handlers, {});
});

test('same-sheet choices share one actual SVG request and the last choice determines its crop', async () => {
  const p = page();
  const pending = [p.click('theme-next'), p.click('theme-next'), p.click('theme-next')];
  assert.equal(p.loads.length, 1);
  assert.equal(p.loads[0].url, '/brand/four-eye-serif-wave-conversation-options.png');
  assert.equal(p.root.dataset.theme, 'butter'); assert.equal(p.active().length, 0);
  p.loads[0].resolve(); await Promise.all(pending);
  assert.equal(p.root.dataset.theme, 'ribbon');
  assert.equal(p.node('brand-palette-art').attrs.viewBox, '20 615 735 305');
  assert.deepEqual(p.writes.map(item => item.value), ['ribbon']);
});

test('cross-sheet loading preserves the current image, crop and palette until the new target loads', async () => {
  const p = page();
  p.pick('eye'); p.loads[0].resolve(); await settle();
  const current = p.active()[0], crop = p.node('brand-palette-art').attrs.viewBox;
  p.pick('splash-check');
  assert.equal(p.loads.length, 2); assert.equal(p.root.dataset.theme, 'eye');
  assert.equal(p.active()[0], current); assert.equal(p.active().length, 1);
  assert.equal(p.node('brand-palette-art').attrs.viewBox, crop);
  assert.equal(p.loads[1].node.attrs.opacity, '0');
  assert.equal(current.attrs.href, '/brand/four-eye-serif-wave-conversation-options.png');
  p.loads[1].resolve(); await settle();
  assert.equal(p.root.dataset.theme, 'splash-check'); assert.equal(p.active()[0], p.loads[1].node);
  assert.equal(current.attrs.opacity, '0');
  assert.equal(p.clip(), 'M30 58H740V375H345V445H30Z');
});

test('out-of-order cross-sheet success and failure cannot replace the latest selected direction', async () => {
  for (const lateFailure of [false, true]) {
    const p = page();
    p.pick('eye'); p.pick('splash-check'); p.pick('editorial');
    assert.equal(p.loads.length, 3); assert.equal(p.active().length, 0);
    p.loads[2].resolve(); await settle();
    assert.equal(p.root.dataset.theme, 'editorial');
    p.loads[0].resolve();
    if (lateFailure) p.loads[1].reject(); else p.loads[1].resolve();
    await settle();
    assert.equal(p.root.dataset.theme, 'editorial'); assert.equal(p.active()[0], p.loads[2].node);
    assert.equal(p.active().length, 1); assert.equal(p.node('theme-feedback').textContent, '');
    assert.deepEqual(p.writes.map(item => item.value), ['editorial']);
  }
});

test('a cross-sheet failure keeps the previously displayed art and a retry reuses only the failed node', async () => {
  const p = page();
  p.pick('eye'); p.loads[0].resolve(); await settle();
  const current = p.active()[0], crop = p.node('brand-palette-art').attrs.viewBox;
  p.pick('melting-type'); const failedNode = p.loads[1].node; p.loads[1].reject(); await settle();
  assert.equal(p.root.dataset.theme, 'eye'); assert.equal(p.active()[0], current);
  assert.equal(p.node('brand-palette-art').attrs.viewBox, crop);
  assert.equal(p.node('theme-choice').value, 'eye'); assert.equal(failedNode.attrs.href, undefined);
  assert.deepEqual(failedNode.handlers, {});
  assert.match(p.node('theme-feedback').textContent, /Showing Eye/);
  p.pick('peel-back'); assert.equal(p.loads.length, 3); assert.equal(p.loads[2].node, failedNode);
  p.loads[2].resolve(); await settle();
  assert.equal(p.root.dataset.theme, 'peel-back'); assert.equal(p.active()[0], failedNode);
  assert.equal(p.clip(), 'M80 550H740V890H325V955H30V580H80Z');
  assert.deepEqual(p.writes.map(item => item.value), ['eye', 'peel-back']);
});

test('returning to an already loaded sheet cancels the pending selection without changing the current image', async () => {
  const p = page();
  p.pick('eye'); p.loads[0].resolve(); await settle();
  p.pick('geometric'); p.pick('conversation');
  assert.equal(p.root.dataset.theme, 'conversation'); assert.equal(p.active()[0], p.loads[0].node);
  p.loads[1].resolve(); await settle();
  assert.equal(p.root.dataset.theme, 'conversation'); assert.equal(p.active()[0], p.loads[0].node);
  assert.deepEqual(p.writes.map(item => item.value), ['eye', 'conversation']);
});

test('returning to Butter cancels all pending sheets without a late theme or error', async () => {
  for (const fail of [false, true]) {
    const p = page();
    p.pick('eye'); p.pick('splash-check'); p.pick('butter');
    p.loads[0].resolve();
    if (fail) p.loads[1].reject(); else p.loads[1].resolve();
    await settle();
    assert.equal(p.root.dataset.theme, 'butter'); assert.equal(p.active().length, 0);
    assert.equal(p.node('theme-feedback').textContent, '');
    assert.deepEqual(p.writes.map(item => item.value), ['butter']);
  }
});

test('a saved direction loads only its own sheet and preserves storage until the user makes a choice', async () => {
  const p = page({ saved: 'humanist' });
  assert.equal(p.root.dataset.theme, 'butter'); assert.equal(p.loads.length, 1);
  assert.equal(p.loads[0].url, '/brand/four-serious-typographic-options.png');
  p.loads[0].resolve(); await settle();
  assert.equal(p.root.dataset.theme, 'humanist'); assert.equal(p.writes.length, 0);
  assert.equal(p.node('brand-palette-art').attrs.viewBox, '810 680 700 145');
});

test('a pending saved direction cannot override a later user choice and storage may be blocked', async () => {
  for (const blockedStorage of [false, true]) {
    const p = page({ saved: 'humanist', blockedStorage });
    p.pick('eye'); p.loads.at(-1).resolve(); await settle();
    if (!blockedStorage) { p.loads[0].reject(); await settle(); }
    assert.equal(p.root.dataset.theme, 'eye'); assert.equal(p.node('theme-feedback').textContent, '');
  }
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
