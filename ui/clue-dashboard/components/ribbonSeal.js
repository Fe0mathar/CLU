// Custom cut-corner strokes and wide tracking keep the green instrumentation legible at ribbon scale.
const sealGlyphs = {
  0: 'M1 0H5L6 1V7L5 8H1L0 7V1Z',
  1: 'M1.5 1.5L3 0H3.5V8M1.5 8H5.5',
  2: 'M0 1L1 0H5L6 1V3L0 7V8H6',
  3: 'M0 0H5L6 1V3L5 4H1.8M5 4L6 5V7L5 8H0',
  4: 'M4 0L0 5V5.5H6M4.8 2.2V8',
  5: 'M6 0H0V3.8H5L6 4.8V7L5 8H0',
  6: 'M6 0H1L0 1V7L1 8H5L6 7V5L5 4H0',
  7: 'M0 0H6V.7L2.5 8',
  8: 'M1 0H5L6 1V3L5 4H1L0 3V1ZM1 4L0 5V7L1 8H5L6 7V5L5 4',
  9: 'M0 8H5L6 7V1L5 0H1L0 1V3L1 4H6',
  A: 'M0 8V2L2 0H4L6 2V8M1.1 5H4.9',
  B: 'M0 0H4.7L5.7 1V3L4.7 4H0M4.7 4L6 5.2V7L5 8H0V0',
  C: 'M6 0H1L0 1V7L1 8H6',
  D: 'M0 0H4.4L6 1.6V6.4L4.4 8H0Z',
  E: 'M6 0H0V8H6M1.2 4H5.2',
  F: 'M6 0H0V8M1.2 4H5.2',
};

const DIGITS = 16;
const STEP_MS = 175;
const FLAP_MS = 150;
const REVEAL_MS = (DIGITS - 1) * STEP_MS + FLAP_MS + 32;
const SVG_NS = 'http://www.w3.org/2000/svg';

export function createSealReveal({
  onStart, onCommit, reducedMotion = () => false, schedule = setTimeout, cancel = clearTimeout,
  settleMs = 240, revealMs = REVEAL_MS, holdMs = 2200,
}) {
  let displayed = null;
  let newest = null;
  let timer = null;

  function start() {
    timer = null;
    if (newest === displayed) return;
    const next = newest;
    if (reducedMotion()) {
      finish(next);
      return;
    }
    timer = schedule(() => finish(next), revealMs);
    onStart(next, displayed);
  }

  function finish(hash) {
    displayed = hash;
    timer = schedule(start, holdMs);
    onCommit(hash);
  }

  return {
    offer(hash) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) return;
      newest = hash.toUpperCase();
      if (timer === null && newest !== displayed) timer = schedule(start, settleMs);
    },
    reset() {
      if (timer !== null) cancel(timer);
      displayed = newest = timer = null;
      onCommit(null);
    },
  };
}

function makeGlyph(document, digit) {
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', '-1 -1 8 10');
  if (digit !== undefined) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', sealGlyphs[digit]);
    icon.append(path);
  }
  return icon;
}

function makeFace(document, variant, digit) {
  const face = document.createElement('span');
  face.className = `clue-seal-face ${variant}`;
  face.append(makeGlyph(document, digit));
  return face;
}

function makeTile(document, next, previous, index, flipping) {
  const tile = document.createElement('span');
  tile.className = 'clue-seal-tile';
  if (!flipping) {
    tile.append(makeFace(document, 'clue-seal-settled', next));
    return tile;
  }
  tile.style.setProperty('--flap-delay', `${index * STEP_MS}ms`);
  tile.style.setProperty('--flap-time', `${FLAP_MS}ms`);
  tile.append(
    makeFace(document, 'clue-seal-before', previous),
    makeFace(document, 'clue-seal-after', next),
    makeFace(document, 'clue-seal-fold-up', previous),
    makeFace(document, 'clue-seal-fold-down', next),
  );
  return tile;
}

export function mountRibbonSeal(seal) {
  const document = seal.ownerDocument;
  const motion = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const value = seal.querySelector('.clue-ribbon-seal-value');
  const glyphs = seal.querySelector('.clue-ribbon-seal-glyphs');

  function paint(hash, previous, flipping) {
    glyphs.toggleAttribute('hidden', hash === null);
    glyphs.replaceChildren(...[...(hash?.slice(0, DIGITS) ?? '')].map((digit, index) =>
      makeTile(document, digit, previous?.[index], index, flipping),
    ));
  }

  return createSealReveal({
    reducedMotion: () => motion?.matches === true,
    onStart(hash, previous) {
      paint(hash, previous, true);
      seal.classList.add('is-flipping');
    },
    onCommit(hash) {
      seal.classList.remove('is-flipping');
      paint(hash, null, false);
      value.textContent = hash?.slice(0, DIGITS) ?? '—';
      seal.toggleAttribute('data-hash', hash !== null);
      seal.title = hash === null ? 'Awaiting a sealed status frame' : `Status seal SHA-256: ${hash}`;
    },
  });
}
