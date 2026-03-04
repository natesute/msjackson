import { StrudelMirror, initEditor, compartments, extensions, addWidget, setSliderWidgets, updateMiniLocations } from '@strudel/codemirror';
import {
  getAudioContext,
  webaudioOutput,
  initAudioOnFirstClick,
  registerSynthSounds,
  samples,
} from '@strudel/webaudio';
import { transpiler } from '@strudel/transpiler';
import { evalScope } from '@strudel/core';
import { toggleLineComment } from '@codemirror/commands';
import { Prec, StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const songCode = `setcpm(95/4)
//all(x => x.scope({ color: '#ffffff22', thickness: 1, scale: 0.05 }))
// VOCAL
$: note("<[~ ~ ~ a4 e5 d5 d5 d5 ~ e5 ~ ~ a5@4] [e5 ~ e5 ~ e5 ~ g5@3 f5 e5 ~ ~ ~ ~ ~] [d5 ~ e5 ~ d5 ~ e5 ~ d5 ~ e5 d5 ~ e5 a4 ~] [a4 ~ e5 ~ d5 ~ e5 ~ d5 ~ e5 d5 ~ e5 a4 ~]>")
  .sound("sawtooth").gain(.8).clip(.7).release(.5).lpf(2100).room(.2).size(2).color("#ff8844").delay(.3)
  ._spiral({ stretch: 0.5, size: 200, thickness: 30, steady: 0, fade: 0.001, colorizeInactive: 0 })
// BASS
$: stack(
   note("<[f2 ~ ~ ~ ~ ~ f2 ~ ~ ~ f1 f2 ~ ~ ~ ~] [f2 ~ ~ ~ ~ ~ f2 ~ ~ ~ f2 g2 ~ ~ g2 ~] [a2 ~ ~ ~ ~ ~ a2 ~ ~ ~ a1 a2 ~ ~ a2 ~] [g2 ~ ~ ~ ~ ~ g2 ~ ~ ~ g1 g2 ~ ~ g2 ~]>")
     .sound("sine").gain(.2).lpf(150).clip(.9).release(0.1),
   note("<[f2 ~ ~ ~ ~ ~ f2 ~ ~ ~ f1 f2 ~ ~ ~ ~] [f2 ~ ~ ~ ~ ~ f2 ~ ~ ~ f2 g2 ~ ~ g2 ~] [a2 ~ ~ ~ ~ ~ a2 ~ ~ ~ a1 a2 ~ ~ a1 ~] [g2 ~ ~ ~ ~ ~ g2 ~ ~ ~ g1 g2 ~ ~ g2 ~]>")
     .sound("square").gain(.2).lpf(sine.range(180,350).slow(8)).lpq(4).clip(.5).release(.1).shape(0.9).postgain(0.3)
 ).color("dodgerblue")._scope()
// ORGAN
$: stack(
  note("<[f4,a4,c5] [[f4,a4,c5]@5 [g4,b4,d5]@3] [a4,c5,e5] [g4,b4,d5]>")
    .sound("sawtooth").release(0.1).gain(.3).lpf(perlin.range(1000,1100)).lpq(2).vib("5:.12").room(.4).size(4)
    .superimpose(x => x.add(note(.08))),
  note("<[f4,a4,c5] [[f4,a4,c5]@5 [g4,b4,d5]@3] [a4,c5,e5] [g4,b4,d5]>")
    .sound("sawtooth").release(0.1).gain(.3).lpf(perlin.range(1100,1200).slow(4)).lpq(2).vib("4.5:.1").shape(.15).postgain(.5).room(0.8).size(5)
    .superimpose(x => x.add(note(-.12)).delay(".3:.12:.5"))
).color("magenta")

// STABS
$: stack(
  note("<[[f4,a4,c5] ~@15] ~ [[a4,c5,e5] ~ ~ ~ [a4,c5,e5] ~ ~ [a4,c5,e5] [a4,c5,e5] ~@7] [[g4,b4,d5] ~ ~ ~ [g4,b4,d5] ~ ~ [g4,b4,d5] [g4,b4,d5] ~@7]>"),
  note("<[[f5,a5,c6] ~@15] ~ [[a5,c6,e6] ~ ~ ~ [a5,c6,e6] ~ ~ [a5,c6,e6] [a5,c6,e6] ~@7] [[g5,b5,d6] ~ ~ ~ [g5,b5,d6] ~ ~ [g5,b5,d6] [g5,b5,d6] ~@7]>")
).sound("piano").gain(.8).clip(.5).release(.7).room(.8).size(7).color("cyan")

// RUNS
$: stack(
  note("<[d5 ~@11] ~ ~ [~@6 c6 b5 a5 g5 f5 e5]>").gain(.9),

  note("<[d6 ~@11] ~ ~ [~@6 c7 b6 a6 g6 f6 e6]>").gain(.7)
).sound("piano").clip(.5).release(.4).delay(".2:.15:.4").room(.3).size(5).color("white")

// DRUMS
$: s("bd").struct("t ~ ~ ~ ~ ~ ~ ~ ~ ~ t ~ ~ ~ ~ ~").bank("RolandTR909").gain(0.2).shape(0.4).release(1).room(.1).color("red")
$: s("sd").struct("~ ~ ~ ~ t ~ ~ ~ ~ ~ ~ ~ t ~ ~ ~").bank("RolandTR909").gain(0.5).room(.2).size(2).color("yellow")
$: s("hh*8").gain("[.25 .35]*4").clip(sine.range(.04,.06).fast(2)).shape(.1).color("lime")`;

/* ── Shared state ────────────────────────────────────────── */
const editorsContainer = document.getElementById('editors-container');
const secondaryEditors = [];
let chunkOffsets = [0]; // character offset of each chunk in combined code
let lastEvalCode = ''; // last evaluated combined code, for location analysis

/* ── Secondary editor highlight decorations ────────────── */
const setSecHighlights = StateEffect.define();
const secHighlightField = StateField.define({
  create() { return Decoration.none; },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setSecHighlights)) return e.value;
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ── Dirty-line tracking ────────────────────────────────── */
const clearDirtyLines = StateEffect.define();
const dirtyLineDeco = Decoration.line({ class: 'cm-dirty-line' });

const dirtyLineField = StateField.define({
  create() { return Decoration.none; },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(clearDirtyLines)) return Decoration.none;
    }
    decos = decos.map(tr.changes);
    if (tr.docChanged) {
      const builder = [];
      tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        const startLine = tr.state.doc.lineAt(fromB).number;
        const endLine = tr.state.doc.lineAt(toB).number;
        for (let ln = startLine; ln <= endLine; ln++) {
          builder.push(dirtyLineDeco.range(tr.state.doc.line(ln).from));
        }
      });
      if (builder.length) {
        decos = decos.update({ add: builder, sort: true });
      }
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ── Statusline ─────────────────────────────────────────── */
const modeEl = document.getElementById('mode');
const infoEl = document.getElementById('info');
const dirtyCountEl = document.getElementById('dirty-count');
let isPlaying = false;
let currentCols = 1;

function updateMode() {
  modeEl.textContent = isPlaying ? 'PLAYING' : 'STOPPED';
  modeEl.className = isPlaying ? 'playing' : 'stopped';
}

function updateDirtyCount() {
  let count = 0;
  try {
    const field = editor.editor.state.field(dirtyLineField, false);
    if (field) {
      const iter = field.iter();
      while (iter.value) { count++; iter.next(); }
    }
  } catch (_) {}
  secondaryEditors.forEach((e) => {
    try {
      const field = e.view.state.field(dirtyLineField, false);
      if (field) {
        const iter = field.iter();
        while (iter.value) { count++; iter.next(); }
      }
    } catch (_) {}
  });
  dirtyCountEl.textContent = count > 0 ? `${count} dirty` : '';
}

// Update dirty count on editor changes
const dirtyCountInterval = setInterval(updateDirtyCount, 500);

/* ── Prebake ────────────────────────────────────────────── */
const CDN = 'https://strudel.b-cdn.net';

async function prebake() {
  initAudioOnFirstClick();
  const modulesLoading = evalScope(
    evalScope,
    import('@strudel/core'),
    import('@strudel/draw'),
    import('@strudel/mini'),
    import('@strudel/tonal'),
    import('@strudel/webaudio'),
  );
  await Promise.all([
    modulesLoading,
    registerSynthSounds(),
    samples(`${CDN}/piano.json`, `${CDN}/piano/`, { prebake: true }),
    samples(`${CDN}/tidal-drum-machines.json`, `${CDN}/tidal-drum-machines/machines/`, { prebake: true }),
    samples('github:tidalcycles/dirt-samples'),
  ]);
}

/* ── StrudelMirror ──────────────────────────────────────── */
const editor = new StrudelMirror({
  root: document.getElementById('editor'),
  defaultOutput: webaudioOutput,
  getTime: () => getAudioContext().currentTime,
  transpiler,
  initialCode: songCode,
  drawTime: [-2, 2],
  prebake,
  onUpdateState: (state) => {
    isPlaying = state.started;
    updateMode();
    if (!state.started) clearAllDirtyLines();
  },
  onError: (err) => console.error(err),
});

/* ── Custom theme (max color variety for Strudel code) ── */
const customThemeColors = EditorView.theme({
  '&': { color: '#bfbdb6', backgroundColor: 'transparent' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#3d4455' },
  '.cm-content': { caretColor: '#e6b450' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#e6b450' },
  '.cm-activeLine': { backgroundColor: '#00000050' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#6c7380' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
    background: 'rgba(230, 180, 80, 0.18) !important',
  },
  '.cm-selectionMatch': { backgroundColor: '#1a1f29' },
}, { dark: true });

const customHighlight = HighlightStyle.define([
  // Labels ($:) — bright coral pink, the section markers
  { tag: t.labelName,                          color: '#f07178' },
  // Keywords (const, let, import, =>, return)
  { tag: t.keyword,                            color: '#c792ea' },
  { tag: t.operatorKeyword,                    color: '#c792ea' },
  // Function calls (note, stack, setcpm, superimpose)
  { tag: t.function(t.variableName),           color: '#ffcb6b' },
  // Property names (.sound, .gain, .lpf, .room, .color)
  { tag: t.propertyName,                       color: '#89ddff' },
  // Strings ("sawtooth", "<[f2 ~ ...]>")
  { tag: t.string,                             color: '#c3e88d' },
  { tag: t.special(t.string),                  color: '#95e6cb' },
  // Numbers (.8, 150, 0.1, 2100)
  { tag: t.number,                             color: '#ff9e64' },
  // Comments (// VOCAL, // BASS)
  { tag: t.comment,                            color: '#546e7a', fontStyle: 'italic' },
  // Operators (+, -, *, /, =, =>)
  { tag: t.operator,                           color: '#f29668' },
  // Brackets and punctuation
  { tag: t.bracket,                            color: '#636d83' },
  { tag: t.paren,                              color: '#636d83' },
  { tag: t.squareBracket,                      color: '#636d83' },
  { tag: t.brace,                              color: '#636d83' },
  { tag: t.punctuation,                        color: '#636d83' },
  // Variables
  { tag: t.variableName,                       color: '#b3b1ad' },
  { tag: t.definition(t.variableName),         color: '#82aaff' },
  // Booleans & atoms
  { tag: [t.atom, t.bool],                     color: '#c792ea' },
  { tag: t.special(t.variableName),            color: '#e6b450' },
  // Types & classes
  { tag: t.typeName,                           color: '#39bae6' },
  { tag: t.className,                          color: '#ffcb6b' },
  // Meta & attributes
  { tag: t.meta,                               color: '#ffcb6b' },
  { tag: t.attributeName,                      color: '#c792ea' },
  // Invalid
  { tag: t.invalid,                            color: '#ff3333' },
]);

editor.editor.dispatch({
  effects: StateEffect.appendConfig.of([
    customThemeColors,
    Prec.highest(syntaxHighlighting(customHighlight)),
  ]),
});

/* ── Guard dispatch against position errors in multi-column mode ── */
const _origDispatch = editor.editor.dispatch.bind(editor.editor);
editor.editor.dispatch = function (...args) {
  if (currentCols > 1) {
    const docLen = editor.editor.state.doc.length;
    for (const spec of args) {
      if (!spec?.effects) continue;
      const effects = Array.isArray(spec.effects) ? spec.effects : [spec.effects];
      for (const eff of effects) {
        // Filter out-of-range widgets so valid ones in this panel still render
        if (eff.is(addWidget)) {
          eff.value = eff.value.filter((w) => w.from <= docLen && w.to <= docLen);
        }
        if (eff.is(setSliderWidgets)) {
          eff.value = eff.value.filter((w) => w.from <= docLen && w.to <= docLen);
        }
      }
    }
  }
  try {
    return _origDispatch(...args);
  } catch (e) {
    if (currentCols > 1 && e.message?.includes('out of range')) {
      return; // suppress any remaining position errors
    }
    throw e;
  }
};

editor.editor.dispatch({
  effects: StateEffect.appendConfig.of(dirtyLineField),
});

// Track cursor position for statusline
editor.editor.dispatch({
  effects: StateEffect.appendConfig.of(
    EditorView.updateListener.of((v) => {
      const pos = v.state.selection.main.head;
      const line = v.state.doc.lineAt(pos);
      const col = pos - line.from + 1;
      infoEl.textContent = `${line.number}:${col}`;
    })
  ),
});

/* ── Word Wrap (Ctrl+W) ────────────────────────────────── */
let wrapEnabled = true;

function setWrap(enabled) {
  wrapEnabled = enabled;
  editor.editor.dispatch({
    effects: compartments.isLineWrappingEnabled.reconfigure(
      extensions.isLineWrappingEnabled(enabled)
    ),
  });
  secondaryEditors.forEach((e) => {
    e.view.dispatch({
      effects: compartments.isLineWrappingEnabled.reconfigure(
        extensions.isLineWrappingEnabled(enabled)
      ),
    });
  });
}

setWrap(true);

/* ── Multi-column (auto-distribute code across panels) ── */
function clearAllDirtyLines() {
  editor.editor.dispatch({ effects: clearDirtyLines.of(null) });
  secondaryEditors.forEach((e) => {
    e.view.dispatch({ effects: clearDirtyLines.of(null) });
  });
}

function evaluateAll(autostart = true) {
  const parts = [editor.code, ...secondaryEditors.map((e) => e.view.state.doc.toString())];
  const allCode = parts.join('\n');
  // Track where each chunk starts in the combined code
  chunkOffsets = [];
  let offset = 0;
  for (const part of parts) {
    chunkOffsets.push(offset);
    offset += part.length + 1; // +1 for the \n separator
  }
  lastEvalCode = allCode;
  editor.flash();
  editor.repl.evaluate(allCode, autostart);
  clearAllDirtyLines();
}

const _origEvaluate = editor.evaluate.bind(editor);
editor.evaluate = function (autostart = true) {
  evaluateAll(autostart);
};

function createSecondaryEditor(initialCode = '') {
  const panel = document.createElement('div');
  panel.className = 'editor-panel';
  editorsContainer.appendChild(panel);

  const view = initEditor({
    root: panel,
    initialCode,
    onEvaluate: () => evaluateAll(),
    onStop: () => editor.stop(),
    onChange: () => {},
  });

  view.dispatch({ effects: StateEffect.appendConfig.of([dirtyLineField, secHighlightField]) });
  view.dispatch({
    effects: StateEffect.appendConfig.of([
      customThemeColors,
      Prec.highest(syntaxHighlighting(customHighlight)),
    ]),
  });
  view.dispatch({
    effects: compartments.isLineWrappingEnabled.reconfigure(
      extensions.isLineWrappingEnabled(wrapEnabled)
    ),
  });

  view.dom.addEventListener('keydown', onEditorKeydown);
  const entry = { view, root: panel };
  secondaryEditors.push(entry);
  return entry;
}

/** Collect all code, split into N roughly-equal chunks at section
 *  boundaries (lines starting with $: or // SECTION), then distribute
 *  across N editor panels. */
function setColumnCount(n) {
  // Gather all code from every panel
  const allCode = [
    editor.code,
    ...secondaryEditors.map((e) => e.view.state.doc.toString()),
  ].join('\n');

  // Tear down existing secondary editors
  while (secondaryEditors.length) {
    const removed = secondaryEditors.pop();
    removed.root.remove();
  }

  currentCols = n;
  if (n === 1) {
    // Single column — put everything back in primary
    editor.setCode(allCode);
    return;
  }

  // Split into sections at $: or // boundaries, then merge comment-only
  // sections with the following code block so headers stay with their code
  const lines = allCode.split('\n');
  const rawSections = [];
  let current = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if ((trimmed.startsWith('$:') || trimmed.startsWith('//')) && current.length > 0) {
      rawSections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length) rawSections.push(current.join('\n'));

  // Merge comment/blank-only sections forward into the next code section
  const sections = [];
  for (let i = 0; i < rawSections.length; i++) {
    const sLines = rawSections[i].split('\n');
    const isCommentOnly = sLines.every((l) => {
      const t = l.trimStart();
      return t === '' || t.startsWith('//');
    });
    if (isCommentOnly && i + 1 < rawSections.length) {
      rawSections[i + 1] = rawSections[i] + '\n' + rawSections[i + 1];
    } else {
      sections.push(rawSections[i]);
    }
  }

  // Distribute sections sequentially (preserving order), balancing by line count
  const totalLines = sections.reduce((sum, s) => sum + s.split('\n').length, 0);
  const targetPerChunk = Math.ceil(totalLines / n);
  const chunks = [[]];
  let currentChunkLines = 0;
  for (const section of sections) {
    const sectionLines = section.split('\n').length;
    if (currentChunkLines > 0 && currentChunkLines + sectionLines > targetPerChunk && chunks.length < n) {
      chunks.push([]);
      currentChunkLines = 0;
    }
    chunks[chunks.length - 1].push(section);
    currentChunkLines += sectionLines;
  }
  while (chunks.length < n) chunks.push([]);

  // Primary editor gets chunk 0
  editor.setCode(chunks[0].join('\n'));

  // Create secondary editors for the rest
  for (let i = 1; i < n; i++) {
    createSecondaryEditor(chunks[i].join('\n'));
  }
}

/* ── Ripples (overlay on #main, crosses columns) ──────── */
const mainEl = document.getElementById('main');
const rippleLayer = document.createElement('div');
rippleLayer.id = 'ripple-layer';
mainEl.appendChild(rippleLayer);

function spawnRipple(x, y, color, gain) {
  const g = Math.max(0.1, Math.min(gain, 1.5));
  const size = 80 + g * 220;
  const border = 2 + g * 2;
  const mainRect = mainEl.getBoundingClientRect();

  const ring = document.createElement('div');
  ring.className = 'ripple';
  ring.style.left = (x - mainRect.left - size / 2) + 'px';
  ring.style.top = (y - mainRect.top - size / 2) + 'px';
  ring.style.width = size + 'px';
  ring.style.height = size + 'px';
  ring.style.borderWidth = border + 'px';
  ring.style.color = color;
  rippleLayer.appendChild(ring);
  ring.addEventListener('animationend', () => ring.remove());
}

/** Resolve viewport coords for a hap location */
function resolveHapPosition(loc) {
  try {
    const coords = editor.editor.coordsAtPos(loc.start);
    if (coords) return { x: coords.left, y: coords.top };
  } catch (_) {}
  for (let i = 0; i < secondaryEditors.length; i++) {
    const off = chunkOffsets[i + 1] ?? Infinity;
    const adjPos = loc.start - off;
    if (adjPos < 0) continue;
    try {
      const coords = secondaryEditors[i].view.coordsAtPos(adjPos);
      if (coords) return { x: coords.left, y: coords.top };
    } catch (_) {}
  }
  return null;
}

/**
 * Find the location in a hap that represents the actual note/beat/trigger,
 * not parameter atoms from .color("magenta"), .sound("sawtooth"), etc.
 *
 * Every string arg in the chain gets mini-parsed, so locations include atoms
 * like "magenta", "sawtooth", "#ff8844", ".25" etc. We only want locations
 * that are musical notes (a4, f2, gs5…) or triggers (t) or sample names (bd, hh…).
 */
const NOTE_RE = /^[a-gA-G][sfb#]?\d+$/;

function findNoteLocation(hap) {
  if (!hap.context?.locations || !lastEvalCode) return null;

  // Pass 1: find a musical note name or trigger 't'
  for (const loc of hap.context.locations) {
    if (loc.start < 0 || loc.end > lastEvalCode.length) continue;
    const text = lastEvalCode.slice(loc.start, loc.end);
    if (NOTE_RE.test(text)) return loc;
    if (text === 't') return loc;
  }

  // Pass 2: match the hap's sample/sound name (bd, sd, hh, etc.)
  const sValue = hap.value?.s;
  if (sValue) {
    for (const loc of hap.context.locations) {
      if (loc.start < 0 || loc.end > lastEvalCode.length) continue;
      const text = lastEvalCode.slice(loc.start, loc.end);
      if (text === sValue) return loc;
    }
  }

  return null;
}

/**
 * Ripple tracking. No setInterval, no grouping, no frequency math.
 * Each hap gets its own entry keyed by time span + source position.
 * Ripples emit on the highlight frame at a fixed rate.
 */
const liveHaps = new Map(); // uid -> { scroller, x, y, color, gain, lastEmit }
const RIPPLE_INTERVAL = 150; // ms between ripples for held notes

const _origHighlight = editor.highlight.bind(editor);
editor.highlight = function (haps, time) {
  _origHighlight(haps, time);

  // Distribute highlights to secondary editors
  if (currentCols > 1 && secondaryEditors.length > 0) {
    for (let i = 0; i < secondaryEditors.length; i++) {
      const sec = secondaryEditors[i];
      const off = chunkOffsets[i + 1] ?? Infinity;
      const docLen = sec.view.state.doc.length;
      const marks = [];
      for (const hap of haps) {
        if (!hap.context?.locations || !hap.whole) continue;
        const color = hap.value?.color ?? 'var(--foreground)';
        const style = hap.value?.markcss || `outline: solid 2px ${color}`;
        for (const loc of hap.context.locations) {
          const from = loc.start - off;
          const to = loc.end - off;
          if (from >= 0 && to <= docLen && from < to) {
            marks.push(Decoration.mark({ attributes: { style } }).range(from, to));
          }
        }
      }
      try {
        sec.view.dispatch({ effects: setSecHighlights.of(Decoration.set(marks, true)) });
      } catch (_) {}
    }
  }

  // Ripples — one per hap, keyed by time span + source location
  const now = performance.now();
  const currentIds = new Set();

  for (const hap of haps) {
    if (!hap.context?.locations || !hap.whole) continue;
    const noteLoc = findNoteLocation(hap);
    if (!noteLoc) continue;

    const uid = `${hap.whole.begin}:${hap.whole.end}:${noteLoc.start}`;
    currentIds.add(uid);

    if (!liveHaps.has(uid)) {
      const resolved = resolveHapPosition(noteLoc);
      if (!resolved) continue;
      liveHaps.set(uid, {
        x: resolved.x,
        y: resolved.y,
        color: hap.value?.color ?? 'white',
        gain: hap.value?.gain ?? 0.5,
        lastEmit: 0,
      });
    }

    const e = liveHaps.get(uid);
    if (now - e.lastEmit >= RIPPLE_INTERVAL) {
      spawnRipple(e.x, e.y, e.color, e.gain);
      e.lastEmit = now;
    }
  }

  for (const [uid] of liveHaps) {
    if (!currentIds.has(uid)) liveHaps.delete(uid);
  }
};

/* ── Keyboard handler (all shortcuts) ───────────────────── */
function onEditorKeydown(e) {
  const ctrl = e.ctrlKey || e.metaKey;

  const view = e.currentTarget.cmView?.view || editor.editor;

  // Ctrl+M — mute (toggle line comment)
  if (ctrl && e.key === 'm') {
    e.preventDefault();
    toggleLineComment(view);
    return;
  }

  // Ctrl+W — toggle word wrap
  if (ctrl && e.key === 'w') {
    e.preventDefault();
    setWrap(!wrapEnabled);
    return;
  }

  // Ctrl+1/2/3 — column count
  if (ctrl && e.key >= '1' && e.key <= '3') {
    e.preventDefault();
    setColumnCount(parseInt(e.key));
    return;
  }

  // Ctrl+U — update live
  if (ctrl && e.key === 'u') {
    e.preventDefault();
    evaluateAll(true);
    return;
  }

  // Ctrl+. — stop
  if (ctrl && e.key === '.') {
    e.preventDefault();
    editor.stop();
    return;
  }
}

editor.editor.dom.addEventListener('keydown', onEditorKeydown);
updateMode();