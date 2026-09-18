import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../site/themes.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function page({ saved, blockedStorage = false } = {}) {
  const nodes = new Map();
  const loads = [], writes = [];
  const root = { dataset: {} };
  for (const id of ['theme-controls', 'theme-current', 'theme-choice', 'brand-palette-art', 'brand-palette-image', 'theme-feedback', 'theme-next', 'theme-previous']) {
    nodes.set(id, {
      hidden: true, value: '', textContent: '', attrs: {}, handlers: {}, options: [],
      setAttribute(key, value) {
        this.attrs[key] = value;
        if (id === 'brand-palette-image' && key === 'href') {
          loads.push({ resolve: this.handlers.load, reject: this.handlers.error });
        }
      },
      removeAttribute(key) { delete this.attrs[key]; },
      removeEventListener(event, callback) { if (this.handlers[event] === callback) delete this.handlers[event]; },
      add(option) { this.options.push(option); },
      addEventListener(event, callback) { this.handlers[event] = callback; },
    });
  }
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
      querySelector(selector) { assert.equal(selector, 'meta[name="theme-color"]'); return { setAttribute() {} }; },
      addEventListener(event, callback) { assert.equal(event, 'DOMContentLoaded'); ready = callback; },
    },
  });
  ready();
  return {
    root, loads, writes,
    node: id => nodes.get(id),
    click: id => nodes.get(id).handlers.click(),
    pick(id) { const select = nodes.get('theme-choice'); select.value = id; return select.handlers.change(); },
  };
}

test('default and invalid saved styles do not request alternate artwork', () => {
  assert.doesNotMatch(html, /<image\b[^>]*\bhref=/i);
  assert.match(html, /<p id="theme-feedback"[^>]*role="status"[^>]*><\/p>/);
  assert.doesNotMatch(html, /<p id="theme-feedback"[^>]*hidden/);
  for (const options of [{}, { saved: 'unknown' }, { blockedStorage: true }]) {
    const p = page(options);
    assert.equal(p.loads.length, 0);
    assert.equal(p.root.dataset.theme, 'butter');
    assert.equal(p.node('theme-controls').hidden, false);
  }
});

test('an alternate palette is applied only after the displayed SVG image loads, and the sheet is reused', async () => {
  const p = page();
  const pending = p.click('theme-next');
  assert.equal(p.loads.length, 1);
  assert.equal(p.root.dataset.theme, 'butter');
  assert.equal(p.node('brand-palette-image').attrs.href, '/brand/serif-palettes.webp');
  assert.equal(p.writes.length, 0);
  p.loads[0].resolve();
  await pending;
  assert.equal(p.root.dataset.theme, 'ivory');
  assert.equal(p.node('brand-palette-image').attrs.href, '/brand/serif-palettes.webp');
  assert.equal(p.node('brand-palette-art').attrs.viewBox, '30 70 460 210');
  assert.equal(p.node('theme-feedback').textContent, '');
  for (let i = 0; i < 8; i++) await p.click('theme-next');
  assert.equal(p.root.dataset.theme, 'butter');
  await p.click('theme-previous');
  assert.equal(p.root.dataset.theme, 'pearl');
  assert.equal(p.loads.length, 1);
});

test('rapid selections share one load and only the most recent choice is applied', async () => {
  const p = page();
  const pending = [p.click('theme-next'), p.click('theme-next'), p.click('theme-next')];
  assert.equal(p.loads.length, 1);
  assert.equal(p.root.dataset.theme, 'butter');
  p.loads[0].resolve();
  await Promise.all(pending);
  assert.equal(p.root.dataset.theme, 'blush');
  assert.deepEqual(p.writes.map(item => item.value), ['blush']);
});

test('returning to Butter cancels a pending selection without a late change or error', async () => {
  for (const fail of [false, true]) {
    const p = page();
    const pending = p.click('theme-next');
    p.pick('butter');
    if (fail) p.loads[0].reject(Error('offline')); else p.loads[0].resolve();
    await pending;
    assert.equal(p.root.dataset.theme, 'butter');
    assert.equal(p.node('theme-feedback').textContent, '');
    assert.deepEqual(p.writes.map(item => item.value), ['butter']);
  }
});

test('an image failure preserves the current style and allows a fresh retry', async () => {
  const p = page();
  const failed = p.click('theme-next');
  p.loads[0].reject(Error('offline'));
  await failed;
  assert.equal(p.root.dataset.theme, 'butter');
  assert.equal(p.node('theme-choice').value, 'butter');
  assert.equal(p.node('brand-palette-image').attrs.href, undefined);
  assert.match(p.node('theme-feedback').textContent, /Choose a style to try again/);
  assert.equal(p.writes.length, 0);
  const retry = p.click('theme-next');
  assert.equal(p.loads.length, 2);
  p.loads[1].resolve();
  await retry;
  assert.equal(p.root.dataset.theme, 'ivory');
  assert.equal(p.node('theme-feedback').textContent, '');
});

test('a saved alternate theme waits for its artwork without overwriting the saved preference', async () => {
  const p = page({ saved: 'sage' });
  assert.equal(p.root.dataset.theme, 'butter');
  assert.equal(p.loads.length, 1);
  p.loads[0].resolve();
  await settle();
  assert.equal(p.root.dataset.theme, 'sage');
  assert.equal(p.node('brand-palette-art').attrs.viewBox, '30 413 460 210');
  assert.equal(p.writes.length, 0);
});

test('style changes still work when preference storage is blocked', async () => {
  const p = page({ blockedStorage: true });
  const pending = p.click('theme-next');
  p.loads[0].resolve();
  await pending;
  assert.equal(p.root.dataset.theme, 'ivory');
  assert.equal(p.node('theme-feedback').textContent, '');
});
