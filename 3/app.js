/* ===== Melody Singer v3 — Canvas 重写 ===== */

// ===== SECTION 1: 常量 =====
const CELL_HEIGHT = 20;
const CELL_WIDTH = 40;
const MIDI_LIB_PPQ = 480; // @tonejs/midi new Midi() 的固定输出 PPQ
const MIDI_HIGH = 83;   // B5
const MIDI_LOW = 36;    // C2
const TOTAL_KEYS = MIDI_HIGH - MIDI_LOW + 1; // 48
const RULER_HEIGHT = 20;
const PIANO_KEY_WIDTH = 60;
const RESIZE_HANDLE_W = 6;
const NOTE_RADIUS = 3;
const DBLCLICK_MS = 400;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 6;
const ZOOM_STEP = 1.15;
const API_BASE = 'http://localhost:5000';
const TRACK_COLORS = ['#3cc5b2','#e04d7f','#e0b820','#4aad5e','#884de0','#e06a28','#2fafa0','#e04a4a'];
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// ===== 乐器采样配置 =====
const INSTRUMENT_CONFIGS = {
    piano: {
        baseUrl: '../samples/piano/',
        samples: {
            'A0': 'A0.mp3', 'C1': 'C1.mp3', 'A1': 'A1.mp3',
            'C2': 'C2.mp3', 'A2': 'A2.mp3',
            'C3': 'C3.mp3', 'A3': 'A3.mp3',
            'C4': 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3', 'A4': 'A4.mp3',
            'C5': 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3', 'A5': 'A5.mp3',
            'C6': 'C6.mp3', 'A6': 'A6.mp3', 'C7': 'C7.mp3', 'C8': 'C8.mp3'
        },
        release: 1.2,
    },
    violin: {
        baseUrl: '../samples/violin/',
        samples: {
            'G3': 'LLVln_ArcoVib_G3_p.mp3', 'A3': 'LLVln_ArcoVib_A3_p.mp3',
            'C4': 'LLVln_ArcoVib_C4_p.mp3', 'E4': 'LLVln_ArcoVib_E4_p.mp3',
            'G4': 'LLVln_ArcoVib_G4_p.mp3', 'A4': 'LLVln_ArcoVib_A4_p.mp3',
            'C5': 'LLVln_ArcoVib_C5_p.mp3', 'E5': 'LLVln_ArcoVib_E5_p.mp3',
            'G5': 'LLVln_ArcoVib_G5_p.mp3', 'A5': 'LLVln_ArcoVib_A5_p.mp3',
            'C6': 'LLVln_ArcoVib_C6_p.mp3', 'E6': 'LLVln_ArcoVib_E6_p.mp3',
            'G6': 'LLVln_ArcoVib_G6_p.mp3', 'A6': 'LLVln_ArcoVib_A6_p.mp3',
            'C7': 'LLVln_ArcoVib_C7_p.mp3',
        },
        release: 0.8,
    },
    guitar: {
        baseUrl: '../samples/guitar/',
        samples: {
            'G#1': 'Gs1_1_1.mp3', 'D#2': 'Ds2_1_1.mp3',
            'G#2': 'Gs2_1_1.mp3', 'C#3': 'Cs3_1_1.mp3',
            'F3': 'F3_1_1.mp3', 'A#3': 'As3_1_1.mp3',
        },
        release: 1.0,
    },
    drums: {
        baseUrl: '../samples/drums/',
        samples: {
            'C2': 'kick-v2.mp3', 'C#2': 'sidestick-v2.mp3',
            'D2': 'snare-v2.mp3', 'E2': 'rimshot-v2.mp3',
            'F2': 'tom-low-v2.mp3', 'F#2': 'hihat-closed-v2.mp3',
            'G2': 'tom-mid-v2.mp3', 'G#2': 'hihat-foot-v2.mp3',
            'A2': 'tom-high-v2.mp3', 'A#2': 'hihat-open-v2.mp3',
            'C#3': 'crash-v2.mp3', 'D#3': 'ride-v2.mp3',
            'F3': 'ride-bell-v2.mp3',
        },
        release: 0.3,
    },
};
// 采样器缓存：{ instrumentId: { sampler, ready } }
const _samplers = {};

/** 获取指定乐器的采样器（懒加载） */
function getInstrumentSampler(instrumentId) {
    const id = instrumentId || 'piano';
    if (_samplers[id]) return _samplers[id].ready ? _samplers[id].sampler : null;
    const cfg = INSTRUMENT_CONFIGS[id];
    if (!cfg || typeof Tone === 'undefined') return null;
    _samplers[id] = { sampler: null, ready: false };
    _samplers[id].sampler = new Tone.Sampler({
        urls: cfg.samples,
        baseUrl: cfg.baseUrl,
        release: cfg.release || 1.0,
        onload: () => {
            _samplers[id].ready = true;
            console.log(id + ' sampler loaded');
        },
    }).toDestination();
    return null; // 首次调用，还在加载
}


// ===== 事件总线（自动批处理，同一同步块内多次 emit 只触发一次 subscriber） =====
const bus = {
    _subs: {},
    _pending: new Set(),
    _scheduled: false,
    on(evt, fn) { (this._subs[evt] ||= []).push(fn); },
    emit(evt) {
        this._pending.add(evt);
        if (!this._scheduled) {
            this._scheduled = true;
            queueMicrotask(() => this._flush());
        }
    },
    _flush() {
        this._scheduled = false;
        const evts = [...this._pending];
        this._pending.clear();
        const done = new Set();
        for (const evt of evts) {
            (this._subs[evt] || []).forEach(fn => {
                if (!done.has(fn)) { done.add(fn); fn(); }
            });
        }
    }
};

// ===== SECTION 2: 全局状态 =====
let noteIdCounter = 0;
const state = {
    notes: [],
    tracks: [],
    activeTrackId: null,
    configTrackId: null,       // 左侧面板正在配置的轨道 ID
    selectedIds: new Set(),
    selectionAnchorId: null,
    tool: 'pointer',
    bpm: 120,
    ppq: 480,
    timeSig: [4, 4],
    zoom: 1.0,
    gridWidth: 0,
    gridHeight: 0,
    midiFile: null,
    midiFileName: '',
    dragging: false,
    dragType: null,
    dragStartX: 0, dragStartY: 0,
    dragCurrentX: 0, dragCurrentY: 0,
    dragNoteId: null,
    dragOffsetX: 0, dragOffsetY: 0,
    dragOriginals: [],
    ghostNote: null,
    knifeLine: null,
    playing: false,
    playheadTime: 0,
    playStartTime: 0,
    animFrameId: null,
    _playStartWall: 0,
    // === 合成 & 短语系统 ===
    synthJobId: null,
    synthDirty: true,
    synthState: 'idle',      // 'idle' | 'preparing' | 'rendering' | 'ready'
    pendingPlay: false,      // 用户按了播放但当前短语还没渲染好
    waitingForPhrase: -1,    // 正在等待渲染的短语 index，-1 表示不在等待
    // Web Audio API 短语播放
    audioCtx: null,
    phraseBuffers: [],       // [{index, startMs, durationMs, audioBuffer}]
    scheduledSources: [],
    synthPhrases: [],        // 从后端获取的短语元信息
    phrasesTotal: 0,
    pollTimer: null,
    _fetchingPhrases: new Set(),
    scrollX: 0,                    // 水平滚动位置（状态化，唯一真相来源）
    _autoFollow: true,          // 播放时自动跟随播放头
    _redrawScheduled: false,
    playingNoteIds: new Set(),
    activeLyricInput: null,
    _lastClickNoteId: null,
    _lastClickTime: 0,
    _panScrollLeft: 0, _panScrollTop: 0,
    // === 音高曲线 ===
    pitchCurve: [],       // [{tick, pitch}] 后端预测（或 mock）的基础音高（MIDI 浮点值）
    pitchDeviation: { xs: [], ys: [] },  // 稀疏控制点，xs 升序，ys 对应 cent 偏移值
    _pitchLastPitch: null, // 画笔上一次采样的 basePitch（MIDI 浮点）
    _pitchLastPoint: null, // 画笔上一个鼠标位置 {cx, cy}
};

// ===== SECTION 2b: Undo/Redo =====
const UNDO_MAX = 100;
const _undoStack = [];
const _redoStack = [];

function takeSnapshot() {
    return {
        notes: state.notes.map(n => ({ ...n })),
        pitchDevs: state.tracks.map(t => ({
            id: t.id,
            xs: t.pitchDeviation ? [...t.pitchDeviation.xs] : [],
            ys: t.pitchDeviation ? [...t.pitchDeviation.ys] : [],
        })),
    };
}

function snapshot() {
    _undoStack.push(takeSnapshot());
    _redoStack.length = 0;
    if (_undoStack.length > UNDO_MAX) _undoStack.shift();
}

function undo() {
    if (_undoStack.length === 0) return;
    _redoStack.push(takeSnapshot());
    restore(_undoStack.pop());
}

function redo() {
    if (_redoStack.length === 0) return;
    _undoStack.push(takeSnapshot());
    restore(_redoStack.pop());
}

function restore(snap) {
    const oldNotes = state.notes;
    state.notes = snap.notes.map(n => ({ ...n }));
    if (snap.notes.length > 0) {
        noteIdCounter = Math.max(noteIdCounter, ...snap.notes.map(n => n.id));
    }
    let pitchChanged = false;
    for (const pd of snap.pitchDevs) {
        const track = state.tracks.find(t => t.id === pd.id);
        if (!track || !track.pitchDeviation) continue;
        const dev = track.pitchDeviation;
        if (dev.xs.length !== pd.xs.length || dev.xs.some((v, i) => v !== pd.xs[i])) {
            dev.xs.length = 0; dev.ys.length = 0;
            for (let i = 0; i < pd.xs.length; i++) { dev.xs.push(pd.xs[i]); dev.ys.push(pd.ys[i]); }
            pitchChanged = true;
        }
    }
    if (getActiveJobId()) {
        _syncNoteEdits(oldNotes, state.notes);
        if (pitchChanged) {
            const dev = getActivePitchDeviation();
            if (dev.xs.length > 0) {
                state._pitchDirtyRange = { min: dev.xs[0], max: dev.xs[dev.xs.length - 1] };
                sendPitchDeviationToBackend();
            }
        }
    }
    invalidateNotes();
    updateInspector();
    requestRedraw('notes');
    requestRedraw('overlay');
}

function _syncNoteEdits(oldNotes, newNotes) {
    const oldMap = new Map(oldNotes.map(n => [n.id, n]));
    const newMap = new Map(newNotes.map(n => [n.id, n]));
    for (const [id, n] of oldMap) {
        if (!newMap.has(id)) pushNoteEdit({ action: 'remove', position: n.tick, duration: n.durTick, tone: n.midi });
    }
    for (const [id, n] of newMap) {
        const old = oldMap.get(id);
        if (!old) {
            pushNoteEdit({ action: 'add', position: n.tick, duration: n.durTick, tone: n.midi, lyric: n.lyric || 'a' });
        } else if (old.tick !== n.tick || old.midi !== n.midi) {
            pushNoteEdit({ action: 'move', position: old.tick, duration: old.durTick, tone: old.midi, newPosition: n.tick, newTone: n.midi });
        } else if (old.durTick !== n.durTick) {
            pushNoteEdit({ action: 'resize', position: n.tick, duration: n.durTick, tone: n.midi });
        } else if (old.lyric !== n.lyric) {
            pushNoteEdit({ action: 'lyric', position: n.tick, duration: n.durTick, tone: n.midi, lyric: n.lyric || 'a' });
        }
    }
}

// ===== SECTION 3: 工具函数 =====
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function isBlackKey(midi) { const n = midi % 12; return [1,3,6,8,10].includes(n); }
function midiNoteName(midi) { return NOTE_NAMES[midi % 12] + Math.floor(midi / 12 - 1); }
function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return String(m).padStart(2,'0') + ':' + s.toFixed(3).padStart(6,'0');
}
function tickToX(tick) { return (tick / state.ppq) * CELL_WIDTH * state.zoom; }
function xToTick(x) { return (x / (CELL_WIDTH * state.zoom)) * state.ppq; }
function tickToTime(tick) { return (tick / state.ppq) * (60 / state.bpm); }
function timeToTick(t) { return (t / (60 / state.bpm)) * state.ppq; }
function midiToY(midi) { return (MIDI_HIGH - midi) * CELL_HEIGHT; }
function yToMidi(y) { return MIDI_HIGH - Math.floor(y / CELL_HEIGHT); }
function yToMidiFloat(y) { return MIDI_HIGH - y / CELL_HEIGHT; }

function getAdaptiveSnap() {
    const bw = CELL_WIDTH * state.zoom;
    if (bw >= 320) return 16;
    if (bw >= 160) return 8;
    if (bw >= 80)  return 4;
    if (bw >= 40)  return 2;
    return 1;
}
function getSnapTicks() { return Math.round(state.ppq / getAdaptiveSnap()); }
function snapTick(tick) { const r = getSnapTicks(); return Math.round(tick / r) * r; }
function snapMidi(y) { return clamp(MIDI_HIGH - Math.floor(y / CELL_HEIGHT), MIDI_LOW, MIDI_HIGH); }

function updateSnapDisplay() {
    const d = getAdaptiveSnap();
    const m = {1:'1/4',2:'1/8',4:'1/16',8:'1/32',16:'1/64'};
    dom.gridSnapDisplay.textContent = 'SNAP: ' + (m[d]||'1/4');
}

// ===== Mutation 函数（所有对 state 的写操作集中在这里，通过 bus 自动触发刷新） =====

function mutateNotes(fn) {
    fn(); // 执行实际修改（如 push、splice、属性修改）
    bus.emit('notes:changed');
}

function mutateTrack(trackId, changes) {
    const track = state.tracks.find(t => t.id === trackId);
    if (!track) return;
    Object.assign(track, changes);
    bus.emit('tracks:changed');
}

function mutateSelection(fn) {
    fn();
    bus.emit('selection:changed');
}

function mutateZoom() {
    // zoom 需要同步刷新（scroll 位置计算依赖 canvas 尺寸）
    (bus._subs['zoom:changed'] || []).forEach(fn => fn());
}

// 兼容：保留直接调用版本（内部走 bus）
function invalidateNotes() { bus.emit('notes:changed'); }
function invalidateTracks() { bus.emit('tracks:changed'); }

/** 滚动位置同步：state.scrollX 是唯一真相，推送到所有可见容器 */
let _scrollSyncing = false;
function mutateScrollX(x) {
    if (_scrollSyncing) return;
    state.scrollX = Math.max(0, x);
    _scrollSyncing = true;
    const pianoOpen = !dom.pianoRoll.classList.contains('hidden');
    if (pianoOpen) dom.gridScrollContainer.scrollLeft = state.scrollX;
    dom.trackTimeline.scrollLeft = state.scrollX;
    if (dom.trackRuler) dom.trackRuler.scrollLeft = state.scrollX;
    _scrollSyncing = false;
}
/** 获取当前活跃的水平滚动容器（可见的那个） */
function getActiveScrollContainer() {
    return dom.pianoRoll.classList.contains('hidden') ? dom.trackTimeline : dom.gridScrollContainer;
}

/** 获取当前活跃的合成 jobId（钢琴卷帘内用轨道的，否则用全局的） */
function getActiveJobId() {
    if (state.activeTrackId && !dom.pianoRoll.classList.contains('hidden')) {
        const track = state.tracks.find(t => t.id === state.activeTrackId);
        if (track && track.synthJobId) return track.synthJobId;
    }
    return state.synthJobId;
}
/** 获取当前活跃的合成轨道对象（仅在钢琴卷帘内且有 synthJobId 时返回） */
function getActiveSynthTrack() {
    if (state.activeTrackId && !dom.pianoRoll.classList.contains('hidden')) {
        const track = state.tracks.find(t => t.id === state.activeTrackId);
        if (track && track.synthJobId) return track;
    }
    return null;
}
/** 获取当前活跃的音高曲线数据 */
function getActivePitchCurve() {
    if (state.activeTrackId && !dom.pianoRoll.classList.contains('hidden')) {
        const track = state.tracks.find(t => t.id === state.activeTrackId);
        if (track && track.pitchCurve && track.pitchCurve.length > 0) return track.pitchCurve;
    }
    return state.pitchCurve;
}

/** 获取当前活跃的音高偏差数据（per-track 或 global） */
function getActivePitchDeviation() {
    if (state.activeTrackId && !dom.pianoRoll.classList.contains('hidden')) {
        const track = state.tracks.find(t => t.id === state.activeTrackId);
        if (track && track.pitchDeviation) return track.pitchDeviation;
    }
    return state.pitchDeviation;
}

function fixEncoding(str) {
    try {
        const bytes = new Uint8Array([...str].map(c => c.charCodeAt(0)));
        return new TextDecoder('utf-8').decode(bytes);
    } catch { return str; }
}

/**
 * 从原始 MIDI ArrayBuffer 中提取所有轨道的 lyrics / text 元事件。
 * @tonejs/midi 的 header.meta 只收集 track 0 的，会漏掉音符轨上的歌词。
 * 这里直接解析二进制，返回 [{tick, text}] 数组（已按 tick 排序）。
 */
function extractAllLyrics(arrayBuffer) {
    const data = new Uint8Array(arrayBuffer);
    let pos = 0;
    const results = [];

    function readUint16() { return (data[pos++] << 8) | data[pos++]; }
    function readUint32() { return ((data[pos++] << 24) | (data[pos++] << 16) | (data[pos++] << 8) | data[pos++]) >>> 0; }
    function readVarInt() {
        let v = 0;
        for (;;) {
            const b = data[pos++];
            v = (v << 7) | (b & 0x7f);
            if (!(b & 0x80)) return v;
        }
    }
    function readString(len) {
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(data[pos++]);
        return s;
    }

    // MThd
    if (readString(4) !== 'MThd') return results;
    const hdrLen = readUint32();
    readUint16(); // format
    const numTracks = readUint16();
    pos += hdrLen - 4; // skip rest of header (we read format + numTracks = 4 bytes, still need to skip ppq etc.)

    for (let t = 0; t < numTracks; t++) {
        if (pos >= data.length) break;
        const chunkId = readString(4);
        const chunkLen = readUint32();
        if (chunkId !== 'MTrk') { pos += chunkLen; continue; }

        const chunkEnd = pos + chunkLen;
        let absTick = 0;
        let runningStatus = 0;

        try {
            while (pos < chunkEnd) {
                const delta = readVarInt();
                absTick += delta;
                let statusByte = data[pos];

                if (statusByte === 0xFF) {
                    pos++; // skip 0xFF
                    const metaType = data[pos++];
                    const len = readVarInt();
                    if (metaType === 0x05 || metaType === 0x01) {
                        let text = readString(len);
                        if (/[\x80-\xff]/.test(text)) text = fixEncoding(text);
                        text = text.trim();
                        if (text) results.push({ tick: absTick, text });
                    } else {
                        pos += len;
                    }
                } else if (statusByte === 0xF0 || statusByte === 0xF7) {
                    pos++;
                    const len = readVarInt();
                    pos += len;
                } else {
                    if (statusByte & 0x80) {
                        runningStatus = statusByte;
                        pos++;
                    } else {
                        statusByte = runningStatus;
                    }
                    const hi = (statusByte >> 4) & 0x0f;
                    if (hi === 0x0C || hi === 0x0D) {
                        pos += 1;
                    } else {
                        pos += 2;
                    }
                }
            }
        } catch (e) {
            // 解析出错时跳到 chunkEnd 继续下一个 track
        }
        pos = chunkEnd;
    }

    results.sort((a, b) => a.tick - b.tick);
    return results;
}

// ===== SECTION 4: DOM 引用与 Canvas 上下文 =====
const dom = {};
const ctx = {};

function cacheDom() {
    const ids = [
        'midiFileInput','menuFile','bpmDisplay','timeDisplay',
        'trackView','trackHeaderCol','trackEmptyHint','trackTimeline',
        'trackResizer',
        'gridSnapDisplay','btnPrev','btnPlay','btnStop','btnNext',
        'btnZoomOut','btnZoomIn','zoomLevel',
        'pianoRoll','pianoKeys','gridScrollContainer','ruler',
        'canvasStack','canvasGrid','canvasNotes','canvasOverlay',
        'playhead',
        'inspectorLyrics','inspectorPitch','inspectorVelocity',
        'tensionSlider','tensionVal','breathSlider','breathVal',
        'voicebankSelect','btnSynthesize',
        'synthProgress','progressFill','progressText','synthError',
        'resultSection','btnDownload',
        'renderStatus',
        'prepareModal','prepareText',
        'batchLyricsModal','batchLyricsInput','batchCharSplit',
        'batchLyricsClose','batchLyricsCancel','batchLyricsApply',
        'trackInspector','trackInspectorName','trackInspectorClose',
        'rendererOptions','vocalSection','trackVoicebankList',
        'instrumentSection','trackInstrumentSelect',
        'pianoRollTrackName','pianoRollClose','btnSoloPlay','btnTrackSynth',
        'trackRuler',
        'midiImportModal','midiImportClose','midiImportBpm',
        'midiImportTsNum','midiImportTsDen',
        'midiImportCancel','midiImportConfirm',
    ];
    ids.forEach(id => { dom[id] = document.getElementById(id); });
    dom.toolBtns = document.querySelectorAll('.tool-btn');
}

// ===== SECTION 5: 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
    cacheDom();

    // ===== 声明式订阅：所有依赖关系在此一处注册 =====
    bus.on('notes:changed', () => {
        requestRedraw('notes');
        requestRedraw('overlay');
        renderTrackTimeline();
        updateInspector();
    });
    bus.on('tracks:changed', () => {
        renderTrackPanel();
        renderTrackTimeline();
        requestRedraw('notes');
        if (state.playing) reschedulePlayback();
    });
    bus.on('selection:changed', () => {
        updateInspector();
        requestRedraw('notes');
    });
    bus.on('zoom:changed', () => {
        resizeCanvases();
        buildRuler();
        buildTrackRuler();
        renderTrackTimeline();
        requestRedraw('all');
        updateSnapDisplay();
    });

    ctx.grid = dom.canvasGrid.getContext('2d');
    ctx.notes = dom.canvasNotes.getContext('2d');
    ctx.overlay = dom.canvasOverlay.getContext('2d');
    buildPianoKeys();
    resizeCanvases();
    requestRedraw('all');
    buildRuler();
    bindEvents();
    bindTrackInspectorEvents();
    bindPianoRollEvents();
    loadVoicebanks();
    initPanelResizers();
    updateSnapDisplay();
    initPianoSampler();
    // 默认钢琴卷帘隐藏
    dom.pianoRoll.parentElement.classList.add('piano-hidden');
});

// ===== SECTION 6: 钢琴键盘 =====
function buildPianoKeys() {
    const inner = document.createElement('div');
    inner.className = 'piano-keys-inner';
    for (let midi = MIDI_HIGH; midi >= MIDI_LOW; midi--) {
        const key = document.createElement('div');
        const black = isBlackKey(midi);
        key.className = 'key ' + (black ? 'black' : 'white');
        if (midi % 12 === 0) key.classList.add('c-note');
        const name = midiNoteName(midi);
        if (midi % 12 === 0 || midi === MIDI_HIGH) key.textContent = name;
        inner.appendChild(key);
    }
    dom.pianoKeys.appendChild(inner);
}

// ===== SECTION 7: Canvas 尺寸与网格绘制 =====
function resizeCanvases() {
    let maxTick = 200 * state.ppq;
    if (state.notes.length > 0) {
        const last = state.notes.reduce((m, n) => Math.max(m, n.tick + n.durTick), 0);
        maxTick = Math.max(maxTick, last + 16 * state.ppq);
    }
    const contentWidth = Math.ceil(tickToX(maxTick));
    const contentHeight = TOTAL_KEYS * CELL_HEIGHT;
    state.gridWidth = contentWidth;
    state.gridHeight = contentHeight;
    // canvas-stack 撑起滚动区域
    dom.canvasStack.style.width = contentWidth + 'px';
    dom.canvasStack.style.height = contentHeight + 'px';
    // canvas 只有 viewport 大小
    const sc = dom.gridScrollContainer;
    const vw = sc.clientWidth || 800;
    const vh = sc.clientHeight || 600;
    const dpr = window.devicePixelRatio || 1;
    [dom.canvasGrid, dom.canvasNotes, dom.canvasOverlay].forEach(c => {
        c.width = vw * dpr;
        c.height = vh * dpr;
        c.style.width = vw + 'px';
        c.style.height = vh + 'px';
    });
    dom.playhead.querySelector('.playhead-line').style.height = (contentHeight + RULER_HEIGHT) + 'px';
}

// 获取当前滚动偏移
function getScrollOffset() {
    const sc = dom.gridScrollContainer;
    return { sx: sc.scrollLeft, sy: sc.scrollTop - RULER_HEIGHT };
}

// 在绘制前调用：设置 canvas 位置 + transform（dpr + 平移）
function prepareCanvas(context, canvas) {
    const dpr = window.devicePixelRatio || 1;
    const { sx, sy } = getScrollOffset();
    // CSS 定位：让 canvas 跟随滚动
    canvas.style.transform = `translate(${sx}px, ${sy + RULER_HEIGHT}px)`;
    // 设置绘制变换：dpr 缩放 + 偏移
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.translate(-sx, -sy);
}

function drawGrid() {
    const c = ctx.grid;
    prepareCanvas(c, dom.canvasGrid);
    const { sx, sy } = getScrollOffset();
    const sc = dom.gridScrollContainer;
    const vw = sc.clientWidth, vh = sc.clientHeight - RULER_HEIGHT;
    // 清除 viewport 区域
    c.clearRect(sx, sy, vw, vh);
    // 只画可见行
    const rowStart = Math.max(0, Math.floor(sy / CELL_HEIGHT));
    const rowEnd = Math.min(TOTAL_KEYS, Math.ceil((sy + vh) / CELL_HEIGHT));
    for (let row = rowStart; row < rowEnd; row++) {
        const midi = MIDI_HIGH - row;
        const y = row * CELL_HEIGHT;
        if (isBlackKey(midi)) {
            c.fillStyle = 'rgba(0,0,0,0.15)';
            c.fillRect(sx, y, vw, CELL_HEIGHT);
        }
        c.strokeStyle = (midi % 12 === 0) ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(sx, y + 0.5);
        c.lineTo(sx + vw, y + 0.5);
        c.stroke();
    }
    // 只画可见列
    const beatWidth = CELL_WIDTH * state.zoom;
    const snapDiv = getAdaptiveSnap();
    const subWidth = beatWidth / snapDiv;
    const beatsPerBar = state.timeSig[0];
    const iStart = Math.max(0, Math.floor(sx / subWidth));
    const iEnd = Math.ceil((sx + vw) / subWidth);
    for (let i = iStart; i <= iEnd; i++) {
        const x = Math.round(i * subWidth) + 0.5;
        const isBar = (i % (snapDiv * beatsPerBar) === 0);
        const isBeat = (i % snapDiv === 0);
        if (isBar) c.strokeStyle = 'rgba(255,255,255,0.25)';
        else if (isBeat) c.strokeStyle = 'rgba(255,255,255,0.12)';
        else c.strokeStyle = 'rgba(255,255,255,0.04)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, sy);
        c.lineTo(x, sy + vh);
        c.stroke();
    }
}

function buildRuler() {
    const beatWidth = CELL_WIDTH * state.zoom;
    const beatsPerBar = state.timeSig[0];
    let maxTick = 200 * state.ppq;
    if (state.notes.length > 0) {
        maxTick = state.notes.reduce((m, n) => Math.max(m, n.tick + n.durTick), 0) + 16 * state.ppq;
    }
    const totalBeats = Math.ceil(maxTick / state.ppq);
    const inner = document.createElement('div');
    inner.className = 'ruler-inner';
    inner.style.width = state.gridWidth + 'px';
    for (let beat = 0; beat <= totalBeats; beat++) {
        const x = beat * beatWidth;
        const isBar = (beat % beatsPerBar === 0);
        const line = document.createElement('div');
        line.className = 'ruler-line ' + (isBar ? 'bar' : 'beat');
        line.style.left = x + 'px';
        inner.appendChild(line);
        if (isBar) {
            const mark = document.createElement('span');
            mark.className = 'ruler-mark bar';
            mark.style.left = (x + 4) + 'px';
            mark.textContent = (beat / beatsPerBar + 1);
            inner.appendChild(mark);
        }
    }
    dom.ruler.innerHTML = '';
    dom.ruler.appendChild(inner);
}

function buildTrackRuler() {
    if (!dom.trackRuler) return;
    const beatWidth = CELL_WIDTH * state.zoom;
    const beatsPerBar = state.timeSig[0];
    let maxTick = 200 * state.ppq;
    if (state.notes.length > 0) {
        maxTick = state.notes.reduce((m, n) => Math.max(m, n.tick + n.durTick), 0) + 16 * state.ppq;
    }
    const totalBeats = Math.ceil(maxTick / state.ppq);
    const totalWidth = Math.ceil(tickToX(maxTick));
    const inner = document.createElement('div');
    inner.className = 'track-ruler-inner';
    inner.style.width = totalWidth + 'px';
    for (let beat = 0; beat <= totalBeats; beat++) {
        const x = beat * beatWidth;
        const isBar = (beat % beatsPerBar === 0);
        const line = document.createElement('div');
        line.className = 'ruler-line ' + (isBar ? 'bar' : 'beat');
        line.style.left = x + 'px';
        inner.appendChild(line);
        if (isBar) {
            const mark = document.createElement('span');
            mark.className = 'ruler-mark bar';
            mark.style.left = (x + 4) + 'px';
            mark.textContent = (beat / beatsPerBar + 1);
            inner.appendChild(mark);
        }
    }
    dom.trackRuler.innerHTML = '';
    dom.trackRuler.appendChild(inner);
    // DOM 重建后恢复滚动位置
    dom.trackRuler.scrollLeft = state.scrollX;
}

// ===== SECTION 8: 音符渲染 (Canvas) =====
function getVisibleNotes() {
    const sc = dom.gridScrollContainer;
    const left = sc.scrollLeft;
    const right = left + sc.clientWidth;
    const top = sc.scrollTop - RULER_HEIGHT;
    const bottom = top + sc.clientHeight;
    const visibleTrackIds = getVisibleTrackIds();
    return state.notes.filter(n => {
        if (!visibleTrackIds.has(n.trackId)) return false;
        const nx = tickToX(n.tick);
        const nw = tickToX(n.tick + n.durTick) - nx;
        const ny = midiToY(n.midi);
        if (nx + nw < left || nx > right) return false;
        if (ny + CELL_HEIGHT < top || ny > bottom) return false;
        return true;
    });
}

function getVisibleTrackIds() {
    // 钢琴卷帘打开时：只显示当前编辑的轨道
    if (state.activeTrackId && !dom.pianoRoll.classList.contains('hidden')) {
        return new Set([state.activeTrackId]);
    }
    const hasSolo = state.tracks.some(t => t.solo);
    const ids = new Set();
    state.tracks.forEach(t => {
        if (hasSolo) { if (t.solo) ids.add(t.id); }
        else { if (!t.muted) ids.add(t.id); }
    });
    if (state.tracks.length === 0) {
        state.notes.forEach(n => ids.add(n.trackId));
    }
    return ids;
}

/** 统一决策：当前应该播放哪些轨道 */
function getPlayableTracks() {
    // 钢琴卷帘打开 → 只播当前轨道
    if (state.activeTrackId && !dom.pianoRoll.classList.contains('hidden')) {
        const t = state.tracks.find(t => t.id === state.activeTrackId);
        return t && !t.muted ? [t] : [];
    }
    // 有 solo → 只播 solo 且非 muted 的
    const hasSolo = state.tracks.some(t => t.solo);
    if (hasSolo) return state.tracks.filter(t => t.solo && !t.muted);
    // 否则 → 全部非 muted
    return state.tracks.filter(t => !t.muted);
}

function computeOverlaps(notes) {
    const overlaps = new Set();
    const sorted = notes.slice().sort((a, b) => a.tick - b.tick);
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            if (sorted[j].tick >= sorted[i].tick + sorted[i].durTick) break;
            if (sorted[i].trackId === sorted[j].trackId && sorted[i].midi === sorted[j].midi) {
                overlaps.add(sorted[i].id);
                overlaps.add(sorted[j].id);
            }
        }
    }
    return overlaps;
}

function drawNotes() {
    const c = ctx.notes;
    prepareCanvas(c, dom.canvasNotes);
    const { sx, sy } = getScrollOffset();
    const sc = dom.gridScrollContainer;
    const vw = sc.clientWidth, vh = sc.clientHeight - RULER_HEIGHT;
    c.clearRect(sx, sy, vw, vh);
    const visibleNotes = getVisibleNotes();
    const overlaps = computeOverlaps(visibleNotes);
    visibleNotes.forEach(note => drawSingleNote(c, note, overlaps.has(note.id)));
}

function drawSingleNote(c, note, isOverlap) {
    const x = tickToX(note.tick);
    const fullW = tickToX(note.tick + note.durTick) - x;
    const w = Math.max(fullW, 6);
    const y = midiToY(note.midi) + 1;
    const h = CELL_HEIGHT - 2;
    const selected = state.selectedIds.has(note.id);
    const playing = state.playing && state.playingNoteIds.has(note.id);

    c.save();

    // 正在播放的音符：外发光
    if (playing) {
        c.shadowColor = '#ffffff88';
        c.shadowBlur = 10;
    }

    c.beginPath();
    c.roundRect(x, y, w, h, NOTE_RADIUS);
    if (playing) {
        // 播放态：高亮白边 + 增亮填充
        c.fillStyle = selected ? '#7df0e6' : lightenColor(note.color || '#4caf50', 50);
        c.strokeStyle = '#ffffff';
        c.lineWidth = 1.5;
    } else if (selected) {
        c.fillStyle = '#5bead6';
        c.strokeStyle = '#ffffff';
        c.lineWidth = 1;
    } else if (isOverlap) {
        c.fillStyle = note.color || '#4caf50';
        c.globalAlpha = 0.45;
        c.strokeStyle = '#ff4444';
        c.lineWidth = 1;
    } else {
        c.fillStyle = note.color || '#4caf50';
        c.strokeStyle = adjustColor(note.color || '#388e3c', -30);
        c.lineWidth = 1;
    }
    c.fill();
    c.stroke();
    c.shadowBlur = 0;

    if (!selected && !isOverlap && !playing) {
        c.shadowColor = (note.color || '#388e3c') + '55';
        c.shadowBlur = 4;
        c.beginPath();
        c.roundRect(x, y, w, h, NOTE_RADIUS);
        c.fill();
        c.shadowBlur = 0;
    }
    c.globalAlpha = 1;

    // 播放进度指示条：在音符内部绘制已播放部分的高亮
    if (playing) {
        const currentTick = timeToTick(state.playheadTime);
        const progress = clamp((currentTick - note.tick) / note.durTick, 0, 1);
        const pw = w * progress;
        c.save();
        c.beginPath();
        c.roundRect(x, y, w, h, NOTE_RADIUS);
        c.clip();
        c.fillStyle = 'rgba(255, 255, 255, 0.15)';
        c.fillRect(x, y, pw, h);
        c.restore();
    }

    if (w > 12) {
        const text = note.lyric || midiNoteName(note.midi);
        c.beginPath();
        c.rect(x + 3, y, w - 6, h);
        c.clip();
        c.font = '600 10px "Segoe UI", "Microsoft YaHei", sans-serif';
        c.fillStyle = (selected || playing) ? '#000000' : '#006400';
        c.textBaseline = 'middle';
        c.fillText(text, x + 4, y + h / 2);
    }
    c.restore();
}

function lightenColor(hex, amount) {
    try {
        let r = parseInt(hex.slice(1,3),16) + amount;
        let g = parseInt(hex.slice(3,5),16) + amount;
        let b = parseInt(hex.slice(5,7),16) + amount;
        r = clamp(r,0,255); g = clamp(g,0,255); b = clamp(b,0,255);
        return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
    } catch { return hex; }
}

function adjustColor(hex, amount) {
    try {
        let r = parseInt(hex.slice(1,3),16) + amount;
        let g = parseInt(hex.slice(3,5),16) + amount;
        let b = parseInt(hex.slice(5,7),16) + amount;
        r = clamp(r,0,255); g = clamp(g,0,255); b = clamp(b,0,255);
        return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
    } catch { return hex; }
}

function drawPitchCurve(c) {
    // 在轨道合成 rendering 或 ready 阶段即显示音高曲线（音高数据在 rendering 初期就已获取）
    let pts = null;
    if (state.activeTrackId && !dom.pianoRoll.classList.contains('hidden')) {
        const track = state.tracks.find(t => t.id === state.activeTrackId);
        // 只要轨道有音高数据就显示（不限定 synthState，数据到了就画）
        if (track && track.pitchCurve && track.pitchCurve.length > 0) {
            pts = track.pitchCurve;
        }
    } else if (state.pitchCurve && state.pitchCurve.length > 0) {
        pts = state.pitchCurve;
    }
    if (!pts || pts.length === 0) return;

    const { xs, ys } = getActivePitchDeviation();

    // viewport 裁剪：只画可见范围内的点
    const { sx } = getScrollOffset();
    const sc = dom.gridScrollContainer;
    const vw = sc.clientWidth;
    const tickLeft = xToTick(sx) - state.ppq * 4;
    const tickRight = xToTick(sx + vw) + state.ppq * 4;

    c.save();
    c.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    c.lineWidth = 1.5;
    c.lineJoin = 'round';
    c.beginPath();
    let started = false;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        // 跳过无效音高（乐句间静音段 pitch=0），断开路径
        if (!p.pitch || p.pitch <= 0) {
            if (started) { c.stroke(); c.beginPath(); started = false; }
            continue;
        }
        if (p.tick < tickLeft) { started = false; continue; }
        if (p.tick > tickRight) break;
        const dev = pitdSample(xs, ys, p.tick);
        const finalPitch = p.pitch + dev / 100;
        const x = tickToX(p.tick);
        const y = midiToY(finalPitch) + CELL_HEIGHT / 2;
        if (i > 0 && started) {
            const gap = pts[i].tick - pts[i - 1].tick;
            if (gap > state.ppq * 4) {
                c.stroke();
                c.beginPath();
                started = false;
            }
        }
        if (!started) { c.moveTo(x, y); started = true; }
        else { c.lineTo(x, y); }
    }
    c.stroke();
    c.restore();
}

// ===== PITD 曲线操作（仿照 OpenUtau UCurve）=====
const PITD_INTERVAL = 5;
const PITD_DEFAULT = 0;

// 二分查找：返回 index（命中）或 ~insertionPoint（未命中）
function pitdBinarySearch(xs, x) {
    let lo = 0, hi = xs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] === x) return mid;
        if (xs[mid] < x) lo = mid + 1;
        else hi = mid - 1;
    }
    return ~lo; // 取反表示未命中，lo 是插入位置
}

// 采样：二分查找 + 线性插值，范围外返回 PITD_DEFAULT
function pitdSample(xs, ys, x) {
    const idx = pitdBinarySearch(xs, x);
    if (idx >= 0) return ys[idx]; // 精确命中
    const ins = ~idx;
    if (ins > 0 && ins < xs.length) {
        // 两个相邻控制点之间线性插值
        const x0 = xs[ins - 1], x1 = xs[ins];
        const y0 = ys[ins - 1], y1 = ys[ins];
        return Math.round(y0 + (y1 - y0) * (x - x0) / (x1 - x0));
    }
    return PITD_DEFAULT;
}

// 插入/更新单个控制点
function pitdInsert(xs, ys, x, y) {
    const idx = pitdBinarySearch(xs, x);
    if (idx >= 0) {
        ys[idx] = y; // 已存在，更新
        return;
    }
    const ins = ~idx;
    xs.splice(ins, 0, x);
    ys.splice(ins, 0, y);
}

// 删除 (x1, x2) 开区间内的所有控制点
function pitdDeleteBetween(xs, ys, x1, x2) {
    let li = pitdBinarySearch(xs, x1);
    if (li >= 0) li++; else li = ~li;
    let ri = pitdBinarySearch(xs, x2);
    if (ri >= 0) ri--; else ri = ~ri - 1;
    if (ri >= li) {
        xs.splice(li, ri - li + 1);
        ys.splice(li, ri - li + 1);
    }
}

// 核心 Set 函数（等同于 UCurve.Set）
function pitdSet(x, y, lastX, lastY) {
    const dev = getActivePitchDeviation();
    const { xs, ys } = dev;
    x = Math.round(x / PITD_INTERVAL) * PITD_INTERVAL;
    lastX = Math.round(lastX / PITD_INTERVAL) * PITD_INTERVAL;
    // clamp to PITD range
    y = clamp(y, -1200, 1200);
    lastY = clamp(lastY, -1200, 1200);

    if (x === lastX) {
        // 同一位置：锁定左右边界 + 设置中心点
        const leftY = pitdSample(xs, ys, x - PITD_INTERVAL);
        const rightY = pitdSample(xs, ys, x + PITD_INTERVAL);
        pitdInsert(xs, ys, x - PITD_INTERVAL, leftY);
        pitdInsert(xs, ys, x, y);
        pitdInsert(xs, ys, x + PITD_INTERVAL, rightY);
    } else if (x < lastX) {
        // 从右向左绘制
        const leftY = pitdSample(xs, ys, x - PITD_INTERVAL);
        pitdDeleteBetween(xs, ys, x, lastX);
        pitdInsert(xs, ys, x - PITD_INTERVAL, leftY);
        pitdInsert(xs, ys, x, y);
    } else {
        // 从左向右绘制
        const rightY = pitdSample(xs, ys, x + PITD_INTERVAL);
        pitdDeleteBetween(xs, ys, lastX, x);
        pitdInsert(xs, ys, x, y);
        pitdInsert(xs, ys, x + PITD_INTERVAL, rightY);
    }
}

// 采样基础音高在指定 tick 处的值（MIDI 浮点），用于画笔计算偏移
function sampleBasePitch(tick) {
    const pts = getActivePitchCurve();
    if (!pts || pts.length === 0) return null;
    let lo = 0, hi = pts.length - 1;
    if (tick <= pts[lo].tick) return pts[lo].pitch;
    if (tick >= pts[hi].tick) return pts[hi].pitch;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].tick <= tick) lo = mid;
        else hi = mid;
    }
    if (pts[hi].tick - pts[lo].tick > state.ppq * 4) return null;
    const t = (tick - pts[lo].tick) / (pts[hi].tick - pts[lo].tick);
    return pts[lo].pitch + (pts[hi].pitch - pts[lo].pitch) * t;
}

// ===== SECTION 9: 覆盖层渲染 =====
function drawOverlay() {
    const c = ctx.overlay;
    prepareCanvas(c, dom.canvasOverlay);
    const { sx, sy } = getScrollOffset();
    const sc = dom.gridScrollContainer;
    const vw = sc.clientWidth, vh = sc.clientHeight - RULER_HEIGHT;
    c.clearRect(sx, sy, vw, vh);

    // 音高曲线
    drawPitchCurve(c);

    if (state.dragType === 'select' && state.dragging) {
        const x = Math.min(state.dragStartX, state.dragCurrentX);
        const y = Math.min(state.dragStartY, state.dragCurrentY);
        const w = Math.abs(state.dragCurrentX - state.dragStartX);
        const h = Math.abs(state.dragCurrentY - state.dragStartY);
        c.fillStyle = 'rgba(91,234,214,0.1)';
        c.strokeStyle = '#5bead6';
        c.lineWidth = 1;
        c.fillRect(x, y, w, h);
        c.strokeRect(x + 0.5, y + 0.5, w, h);
    }
    if (state.tool === 'pencil' && state.ghostNote) {
        const gn = state.ghostNote;
        c.fillStyle = 'rgba(91,234,214,0.3)';
        c.strokeStyle = '#5bead6';
        c.setLineDash([4, 4]);
        c.lineWidth = 1;
        c.beginPath();
        c.roundRect(gn.x, gn.y + 1, gn.w, CELL_HEIGHT - 2, NOTE_RADIUS);
        c.fill();
        c.stroke();
        c.setLineDash([]);
    }
    if (state.tool === 'knife' && state.knifeLine) {
        const kl = state.knifeLine;
        c.strokeStyle = '#ff4466';
        c.lineWidth = 1.5;
        c.setLineDash([3, 3]);
        c.beginPath();
        c.moveTo(kl.x + 0.5, kl.y1);
        c.lineTo(kl.x + 0.5, kl.y2);
        c.stroke();
        c.setLineDash([]);
    }
}

// ===== SECTION 10: 渲染调度 =====
const dirty = { grid: true, notes: true, overlay: true };
function requestRedraw(layer) {
    if (layer === 'all') { dirty.grid = dirty.notes = dirty.overlay = true; }
    else { dirty[layer] = true; }
    if (!state._redrawScheduled) {
        state._redrawScheduled = true;
        requestAnimationFrame(performRedraw);
    }
}
function performRedraw() {
    state._redrawScheduled = false;
    if (dirty.grid)    { drawGrid();    dirty.grid = false; }
    if (dirty.notes)   { drawNotes();   dirty.notes = false; }
    if (dirty.overlay) { drawOverlay(); dirty.overlay = false; }
}

// ===== SECTION 11: 命中检测 =====
function hitTest(cx, cy) {
    const visible = getVisibleNotes();
    for (let i = visible.length - 1; i >= 0; i--) {
        const n = visible[i];
        const nx = tickToX(n.tick);
        const nw = Math.max(tickToX(n.tick + n.durTick) - nx, 6);
        const ny = midiToY(n.midi);
        if (cx >= nx && cx <= nx + nw && cy >= ny && cy <= ny + CELL_HEIGHT) {
            if (cx >= nx + nw - RESIZE_HANDLE_W && nw > RESIZE_HANDLE_W * 2) {
                return { note: n, region: 'right-edge' };
            }
            return { note: n, region: 'body' };
        }
    }
    return null;
}

function canvasCoords(e) {
    const rect = dom.gridScrollContainer.getBoundingClientRect();
    return {
        x: e.clientX - rect.left + dom.gridScrollContainer.scrollLeft,
        // canvas-stack 在文档流中位于 ruler (20px) 之后，
        // 而 prepareCanvas 的 CSS transform 又加了 RULER_HEIGHT，
        // 所以需要减去 2 * RULER_HEIGHT 才能正确映射到内容坐标
        y: e.clientY - rect.top + dom.gridScrollContainer.scrollTop - 2 * RULER_HEIGHT
    };
}

// ===== SECTION 12: 音符 CRUD =====
function createNote(tick, durTick, midi, trackId, lyric) {
    const track = state.tracks.find(t => t.id === (trackId || state.activeTrackId));
    const color = track ? track.color : '#4caf50';
    const n = {
        id: ++noteIdCounter,
        trackId: trackId || state.activeTrackId || 'default',
        midi: clamp(midi, MIDI_LOW, MIDI_HIGH),
        tick, durTick,
        velocity: 100,
        lyric: lyric || 'a',
        color,
    };
    state.notes.push(n);
    if (getActiveJobId()) {
        pushNoteEdit({ action: 'add', position: tick, duration: durTick, tone: midi, lyric: n.lyric });
    }
    invalidateNotes();
    return n;
}

function deleteNote(id) {
    const note = state.notes.find(n => n.id === id);
    if (note && getActiveJobId()) {
        pushNoteEdit({ action: 'remove', position: note.tick, duration: note.durTick, tone: note.midi });
    }
    state.notes = state.notes.filter(n => n.id !== id);
    state.selectedIds.delete(id);
    if (state.notes.length === 0) {
        state.pitchCurve = [];
    }
    invalidateNotes();
}

function deleteSelected() {
    if (state.selectedIds.size === 0) return;
    if (getActiveJobId()) {
        for (const n of state.notes) {
            if (state.selectedIds.has(n.id)) {
                pushNoteEdit({ action: 'remove', position: n.tick, duration: n.durTick, tone: n.midi });
            }
        }
    }
    state.notes = state.notes.filter(n => !state.selectedIds.has(n.id));
    state.selectedIds.clear();
    if (state.notes.length === 0) {
        state.pitchCurve = [];
    }
    invalidateNotes();
}

function sliceNote(noteId, sliceTick) {
    const note = state.notes.find(n => n.id === noteId);
    if (!note) return;
    const leftDur = sliceTick - note.tick;
    const rightDur = note.durTick - leftDur;
    if (leftDur <= 0 || rightDur <= 0) return;
    const oldDur = note.durTick;
    note.durTick = leftDur;
    const newNote = { ...note, id: ++noteIdCounter, tick: sliceTick, durTick: rightDur, lyric: '' };
    state.notes.push(newNote);
    if (getActiveJobId()) {
        pushNoteEdit({ action: 'resize', position: note.tick, duration: leftDur, tone: note.midi });
        pushNoteEdit({ action: 'add', position: sliceTick, duration: rightDur, tone: note.midi, lyric: newNote.lyric || 'a' });
    }
    invalidateNotes();
}

// ===== SECTION 13: 选择逻辑 =====
function selectOnly(id) {
    state.selectedIds.clear();
    state.selectedIds.add(id);
    state.selectionAnchorId = id;
    bus.emit('selection:changed');
}
function toggleSelect(id) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    state.selectionAnchorId = id;
    bus.emit('selection:changed');
}
function deselectAll() {
    if (state.selectedIds.size === 0) return;
    state.selectedIds.clear();
    bus.emit('selection:changed');
}
function selectAll() {
    const vis = getVisibleTrackIds();
    state.notes.forEach(n => { if (vis.has(n.trackId)) state.selectedIds.add(n.id); });
    bus.emit('selection:changed');
}
function shiftClickRange(clickedId) {
    const anchor = state.notes.find(n => n.id === state.selectionAnchorId);
    const clicked = state.notes.find(n => n.id === clickedId);
    if (!anchor || !clicked) { selectOnly(clickedId); return; }
    const minT = Math.min(anchor.tick, clicked.tick);
    const maxT = Math.max(anchor.tick + anchor.durTick, clicked.tick + clicked.durTick);
    const vis = getVisibleTrackIds();
    state.selectedIds.clear();
    state.notes.forEach(n => {
        if (vis.has(n.trackId) && n.tick + n.durTick > minT && n.tick < maxT) state.selectedIds.add(n.id);
    });
    bus.emit('selection:changed');
}
function boxSelect(x1, y1, x2, y2, additive) {
    const left = Math.min(x1, x2), right = Math.max(x1, x2);
    const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
    const vis = getVisibleTrackIds();
    if (!additive) state.selectedIds.clear();
    state.notes.forEach(n => {
        if (!vis.has(n.trackId)) return;
        const nx = tickToX(n.tick);
        const nw = tickToX(n.tick + n.durTick) - nx;
        const ny = midiToY(n.midi);
        if (nx + nw >= left && nx <= right && ny + CELL_HEIGHT >= top && ny <= bottom) {
            state.selectedIds.add(n.id);
        }
    });
    bus.emit('selection:changed');
}

// ===== SECTION 14: 修饰键 =====
function getMods(e) {
    return {
        bypass: e.altKey,
        lockY: e.shiftKey && !e.ctrlKey && !e.metaKey,
        lockX: (e.ctrlKey || e.metaKey) && !e.shiftKey,
        micro: (e.ctrlKey || e.metaKey) && e.shiftKey,
    };
}

// ===== SECTION 15: 工具状态机 =====
const tools = {
    pointer: {
        cursor: 'default',
        onMouseDown(e, cx, cy) {
            const hit = hitTest(cx, cy);
            if (hit) {
                const nId = hit.note.id;
                const now = Date.now();
                if (state._lastClickNoteId === nId && now - state._lastClickTime < DBLCLICK_MS) {
                    state._lastClickNoteId = null;
                    e.preventDefault();
                    openLyricEditor(hit.note);
                    return;
                }
                state._lastClickNoteId = nId;
                state._lastClickTime = now;
                if (e.shiftKey) { shiftClickRange(nId); return; }
                if (e.ctrlKey || e.metaKey) { toggleSelect(nId); return; }
                if (!state.selectedIds.has(nId)) selectOnly(nId);
                if (hit.region === 'right-edge') {
                    snapshot();
                    state.dragging = true;
                    state.dragType = 'resize';
                    state.dragNoteId = nId;
                    state.dragStartX = cx;
                    state.dragOriginals = [];
                    state.selectedIds.forEach(id => {
                        const n = state.notes.find(nn => nn.id === id);
                        if (n) state.dragOriginals.push({ id: n.id, durTick: n.durTick });
                    });
                } else {
                    snapshot();
                    state.dragging = true;
                    state.dragType = 'move';
                    state.dragNoteId = nId;
                    state.dragStartX = cx;
                    state.dragStartY = cy;
                    state.dragOriginals = [];
                    state.selectedIds.forEach(id => {
                        const n = state.notes.find(nn => nn.id === id);
                        if (n) state.dragOriginals.push({ id: n.id, tick: n.tick, midi: n.midi, durTick: n.durTick });
                    });
                }
            } else {
                state._lastClickNoteId = null;
                if (!e.ctrlKey && !e.metaKey) deselectAll();
                state.dragging = true;
                state.dragType = 'select';
                state.dragStartX = cx;
                state.dragStartY = cy;
                state.dragCurrentX = cx;
                state.dragCurrentY = cy;
            }
        },
        onMouseMove(e, cx, cy) {
            if (!state.dragging) {
                const hit = hitTest(cx, cy);
                dom.gridScrollContainer.style.cursor = hit
                    ? (hit.region === 'right-edge' ? 'col-resize' : 'grab') : 'default';
                return;
            }
            if (state.dragType === 'select') {
                state.dragCurrentX = cx;
                state.dragCurrentY = cy;
                requestRedraw('overlay');
                return;
            }
            const mod = getMods(e);
            if (state.dragType === 'move') {
                const dx = cx - state.dragStartX;
                const dy = cy - state.dragStartY;
                state.dragOriginals.forEach(orig => {
                    const n = state.notes.find(nn => nn.id === orig.id);
                    if (!n) return;
                    if (!mod.lockX && !mod.micro) {
                        const deltaTick = xToTick(dx);
                        // snap 偏移量而非绝对位置，避免非网格音符被吸走
                        const snappedDelta = mod.bypass ? Math.round(deltaTick) : snapTick(deltaTick);
                        n.tick = Math.max(0, orig.tick + snappedDelta);
                    }
                    if (!mod.lockY) {
                        if (mod.micro) {
                            const steps = Math.round(dy / (CELL_HEIGHT / 4));
                            n.midi = clamp(orig.midi - steps, MIDI_LOW, MIDI_HIGH);
                        } else {
                            const newMidi = orig.midi - Math.round(dy / CELL_HEIGHT);
                            n.midi = clamp(newMidi, MIDI_LOW, MIDI_HIGH);
                        }
                    }
                });
                requestRedraw('notes');
            }
            if (state.dragType === 'resize') {
                const dx = cx - state.dragStartX;
                state.dragOriginals.forEach(orig => {
                    const n = state.notes.find(nn => nn.id === orig.id);
                    if (!n) return;
                    const newDur = orig.durTick + xToTick(dx);
                    const minDur = getSnapTicks();
                    n.durTick = e.altKey ? Math.max(minDur / 4, Math.round(newDur)) : Math.max(minDur, snapTick(newDur));
                });
                requestRedraw('notes');
            }
        },
        onMouseUp(e, cx, cy) {
            if (state.dragType === 'select') {
                boxSelect(state.dragStartX, state.dragStartY, state.dragCurrentX, state.dragCurrentY, e.ctrlKey || e.metaKey);
            }
            if (state.dragType === 'move' || state.dragType === 'resize') {
                if (getActiveJobId() && state.dragOriginals.length > 0) {
                    state.dragOriginals.forEach(orig => {
                        const n = state.notes.find(nn => nn.id === orig.id);
                        if (!n) return;
                        if (state.dragType === 'move') {
                            if (n.tick !== orig.tick || n.midi !== orig.midi) {
                                pushNoteEdit({
                                    action: 'move',
                                    position: orig.tick, duration: orig.durTick, tone: orig.midi,
                                    newPosition: n.tick, newTone: n.midi,
                                });
                            }
                        } else {
                            if (n.durTick !== orig.durTick) {
                                pushNoteEdit({
                                    action: 'resize',
                                    position: n.tick, duration: n.durTick, tone: n.midi,
                                });
                            }
                        }
                    });
                }
            }
            state.dragging = false;
            state.dragType = null;
            state.dragOriginals = [];
            requestRedraw('overlay');
            requestRedraw('notes');
            updateInspector();
        },
    },
    pencil: {
        cursor: 'crosshair',
        onMouseDown(e, cx, cy) {
            snapshot();
            const tick = e.altKey ? Math.max(0, Math.round(xToTick(cx))) : Math.max(0, snapTick(xToTick(cx)));
            const midi = snapMidi(cy);
            const durTick = getSnapTicks();
            const n = createNote(tick, durTick, midi);
            selectOnly(n.id);
            state.dragging = true;
            state.dragType = 'create';
            state.dragNoteId = n.id;
            state.dragStartX = cx;
        },
        onMouseMove(e, cx, cy) {
            if (state.dragging && state.dragType === 'create') {
                const n = state.notes.find(nn => nn.id === state.dragNoteId);
                if (!n) return;
                const dx = cx - state.dragStartX;
                const newDur = getSnapTicks() + xToTick(dx);
                n.durTick = Math.max(getSnapTicks(), e.altKey ? Math.round(newDur) : snapTick(newDur));
                requestRedraw('notes');
            } else {
                const tick = e.altKey ? xToTick(cx) : snapTick(xToTick(cx));
                const midi = snapMidi(cy);
                state.ghostNote = { x: tickToX(tick), y: midiToY(midi), w: tickToX(getSnapTicks()) };
                requestRedraw('overlay');
            }
        },
        onMouseUp() {
            state.dragging = false;
            state.dragType = null;
            state.ghostNote = null;
            requestRedraw('overlay');
            updateInspector();
        },
    },
    eraser: {
        cursor: 'pointer',
        onMouseDown(e, cx, cy) {
            const hit = hitTest(cx, cy);
            if (hit) {
                snapshot();
                deleteNote(hit.note.id);
                state.dragging = true;
                state.dragType = 'erase';
            }
        },
        onMouseMove(e, cx, cy) {
            if (state.dragging && state.dragType === 'erase') {
                const hit = hitTest(cx, cy);
                if (hit) deleteNote(hit.note.id);
            }
        },
        onMouseUp() {
            state.dragging = false;
            state.dragType = null;
            updateInspector();
        },
    },
    knife: {
        cursor: 'col-resize',
        onMouseDown(e, cx, cy) {
            const hit = hitTest(cx, cy);
            if (!hit) return;
            snapshot();
            const sliceTick = e.altKey ? Math.round(xToTick(cx)) : snapTick(xToTick(cx));
            sliceNote(hit.note.id, sliceTick);
        },
        onMouseMove(e, cx, cy) {
            const hit = hitTest(cx, cy);
            if (hit) {
                const snappedX = e.altKey ? cx : tickToX(snapTick(xToTick(cx)));
                state.knifeLine = {
                    x: snappedX,
                    y1: midiToY(hit.note.midi),
                    y2: midiToY(hit.note.midi) + CELL_HEIGHT,
                };
            } else {
                state.knifeLine = null;
            }
            dom.gridScrollContainer.style.cursor = hit ? 'col-resize' : 'default';
            requestRedraw('overlay');
        },
        onMouseUp() {
            state.knifeLine = null;
            requestRedraw('overlay');
        },
    },
    pitchpen: {
        cursor: 'crosshair',
        onMouseDown(e, cx, cy) {
            snapshot();
            if (e.button === 2) {
                // 右键：ResetPitchState — 将 PITD 设为 0
                state.dragging = true;
                state.dragType = 'pitch-reset';
                state._pitchLastPoint = { cx, cy };
                state._pitchDirtyRange = { min: Infinity, max: -Infinity };
                const tick = xToTick(cx);
                pitdSet(tick, 0, tick, 0);
                state._pitchDirtyRange.min = Math.min(state._pitchDirtyRange.min, tick);
                state._pitchDirtyRange.max = Math.max(state._pitchDirtyRange.max, tick);
                requestRedraw('overlay');
                return;
            }
            // 左键：DrawPitchState — 开始记录起点
            state.dragging = true;
            state.dragType = 'pitch-draw';
            state._pitchLastPitch = null;
            state._pitchLastPoint = { cx, cy };
            state._pitchDirtyRange = { min: Infinity, max: -Infinity };
            state._pitchDiagLog = [];
        },
        onMouseMove(e, cx, cy) {
            if (!state.dragging) return;

            const tick = xToTick(cx);

            if (state.dragType === 'pitch-reset') {
                // 右键拖拽：连续重置为 0
                const lastTick = xToTick(state._pitchLastPoint.cx);
                pitdSet(tick, 0, lastTick, 0);
                state._pitchDirtyRange.min = Math.min(state._pitchDirtyRange.min, tick, lastTick);
                state._pitchDirtyRange.max = Math.max(state._pitchDirtyRange.max, tick, lastTick);
                state._pitchLastPoint = { cx, cy };
                requestRedraw('overlay');
                return;
            }

            // DrawPitchState 逻辑（完全照搬 OpenUtau）
            // 1. 量化 tick 到 5-tick 间隔再采样基础音高
            const snapTick = Math.round(tick / PITD_INTERVAL) * PITD_INTERVAL;
            const basePitch = sampleBasePitch(snapTick);
            if (basePitch == null) return;

            // 2. 鼠标 Y → 目标音高（tone），计算偏差 cent
            const tone = yToMidiFloat(cy - CELL_HEIGHT / 2);
            const cent = Math.round(tone * 100 - basePitch * 100);

            // 3. 计算上一个点的 tick 和 cent
            // OpenUtau 关键设计：lastY 使用【当前 tone】减去【上一次的 basePitch】
            // 这样 y 和 lastY 之间只有 basePitch 的差异，没有 tone 跳变
            const lastTick = xToTick(state._pitchLastPitch == null
                ? cx : state._pitchLastPoint.cx);
            const lastCent = Math.round(tone * 100
                - (state._pitchLastPitch ?? basePitch) * 100);

            // 4. 写入 PITD 曲线
            pitdSet(tick, cent, lastTick, lastCent);
            state._pitchDirtyRange.min = Math.min(state._pitchDirtyRange.min, tick, lastTick);
            state._pitchDirtyRange.max = Math.max(state._pitchDirtyRange.max, tick, lastTick);
            state._pitchLastPitch = basePitch;
            state._pitchLastPoint = { cx, cy };

            // 诊断：鼠标位置 vs 系统计算出的绘制位置
            const drawnPitch = basePitch + cent / 100;
            if (state._pitchDiagLog) {
                state._pitchDiagLog.push({
                    tick: Math.round(tick),
                    mouseMidi: +tone.toFixed(4),
                    drawnMidi: +drawnPitch.toFixed(4),
                    diffCent: Math.round((tone - drawnPitch) * 100),
                    basePitch: +basePitch.toFixed(4),
                    cent,
                });
            }

            requestRedraw('overlay');
        },
        onMouseUp(e, cx, cy) {
            if (state._pitchDiagLog && state._pitchDiagLog.length > 0) {
                console.log('[pitch-diag] 鼠标轨迹 vs 绘制曲线：');
                console.table(state._pitchDiagLog);
            }
            state._pitchLastPitch = null;
            state._pitchLastPoint = null;
            state.dragging = false;
            state.dragType = null;
            requestRedraw('overlay');
            sendPitchDeviationToBackend();
        },
    },
};

function setTool(name) {
    state.tool = name;
    dom.toolBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === name));
    dom.gridScrollContainer.style.cursor = tools[name].cursor;
    state.ghostNote = null;
    state.knifeLine = null;
    requestRedraw('overlay');
}

// ===== SECTION 16: 歌词编辑 =====
function openLyricEditor(note) {
    closeLyricEditor();
    const input = document.createElement('input');
    input.className = 'lyric-input';
    input.value = note.lyric || '';
    const x = tickToX(note.tick);
    const y = midiToY(note.midi) + RULER_HEIGHT;
    input.style.left = x + 'px';
    input.style.top = y + 'px';
    input.style.height = CELL_HEIGHT + 'px';
    dom.gridScrollContainer.appendChild(input);

    // 延迟聚焦，避免 mousedown 默认行为抢夺焦点导致立即 blur
    let committed = false;
    requestAnimationFrame(() => {
        input.focus();
        input.select();
    });

    const commit = () => {
        if (committed) return;
        committed = true;
        const changed = note.lyric !== input.value;
        if (changed) snapshot();
        note.lyric = input.value;
        if (input.parentNode) input.remove();
        state.activeLyricInput = null;
        if (changed && getActiveJobId()) {
            pushNoteEdit({ action: 'lyric', position: note.tick, duration: note.durTick, tone: note.midi, lyric: note.lyric || 'a' });
        }
        requestRedraw('notes');
        updateInspector();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', ev => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { input.blur(); }
        if (ev.key === 'Escape') { input.value = note.lyric || ''; input.blur(); }
        if (ev.key === 'Tab') {
            ev.preventDefault();
            const sorted = state.notes.slice().sort((a, b) => a.tick - b.tick || a.midi - b.midi);
            const idx = sorted.findIndex(n => n.id === note.id);
            const next = ev.shiftKey ? sorted[idx - 1] : sorted[idx + 1];
            commit();
            if (next) setTimeout(() => openLyricEditor(next), 0);
        }
    });
    state.activeLyricInput = { input, noteId: note.id };
}
function closeLyricEditor() {
    if (state.activeLyricInput) {
        const inp = state.activeLyricInput.input;
        if (inp.parentNode) inp.blur();
    }
}

// ===== SECTION 17: 批量歌词 =====
function openBatchLyrics() {
    if (state.selectedIds.size === 0) return;
    dom.batchLyricsModal.style.display = 'flex';
    // 预填选中音符已有的歌词
    const selected = state.notes
        .filter(n => state.selectedIds.has(n.id))
        .sort((a, b) => a.tick - b.tick || a.midi - b.midi);
    const existing = selected.map(n => n.lyric || 'a').join(' ');
    dom.batchLyricsInput.value = existing;
    dom.batchLyricsInput.focus();
    dom.batchLyricsInput.select();
}
function closeBatchLyrics() { dom.batchLyricsModal.style.display = 'none'; }
function applyBatchLyrics() {
    const text = dom.batchLyricsInput.value.trim();
    if (!text) { closeBatchLyrics(); return; }
    const charSplit = dom.batchCharSplit.checked;
    let words;
    if (charSplit) {
        words = [...text].filter(ch => ch.trim());
    } else {
        words = text.split(/\s+/);
    }
    const selected = state.notes
        .filter(n => state.selectedIds.has(n.id))
        .sort((a, b) => a.tick - b.tick || a.midi - b.midi);
    snapshot();
    for (let i = 0; i < selected.length && i < words.length; i++) {
        selected[i].lyric = words[i];
        if (getActiveJobId()) {
            pushNoteEdit({ action: 'lyric', position: selected[i].tick, duration: selected[i].durTick, tone: selected[i].midi, lyric: words[i] });
        }
    }
    closeBatchLyrics();
    requestRedraw('notes');
    updateInspector();
}

// 生成模拟音高曲线：基于音符数据，每个音符内部以 10 tick 间隔采样
// 加入轻微正弦 vibrato 模拟真实歌声效果
function generateMockPitchCurve() {
    state.pitchCurve = [];
    state.pitchDeviation = { xs: [], ys: [] };
    const sorted = state.notes.slice().sort((a, b) => a.tick - b.tick);
    for (const note of sorted) {
        const step = 10;
        for (let t = note.tick; t < note.tick + note.durTick; t += step) {
            const phase = (t - note.tick) / state.ppq;
            // vibrato: ±0.15 半音，5Hz 相当于约 2.5 个 beat 周期
            const vibrato = 0.15 * Math.sin(phase * Math.PI * 5);
            state.pitchCurve.push({ tick: t, pitch: note.midi + vibrato });
        }
    }
    requestRedraw('overlay');
}

// ===== SECTION 18: MIDI 导入 =====
// 暂存 MIDI 导入数据（弹窗确认前）
let _pendingMidiImport = null;

async function loadMidiFile(file) {
    try {
        const buf = await file.arrayBuffer();

        // 先从原始二进制提取所有轨道的歌词（在 new Midi 之前，确保 buffer 完好）
        const lyrics = extractAllLyrics(buf);

        const midi = new Midi(buf);

        // fallback: 如果二进制解析没拿到歌词，从 header.meta 补
        if (lyrics.length === 0 && midi.header.meta) {
            midi.header.meta.forEach(ev => {
                if (ev.type === 'lyrics' || ev.type === 'text') {
                    let t = ev.text || '';
                    if (t && /[\x80-\xff]/.test(t)) t = fixEncoding(t);
                    t = t.trim();
                    if (t) lyrics.push({ tick: ev.ticks, text: t });
                }
            });
        }

        // 提取 BPM 和拍号
        let detectedBpm = 120;
        let detectedTsNum = 4, detectedTsDen = 4;
        const ppq = midi.header.ppq || 480;
        if (midi.header.tempos && midi.header.tempos.length > 0) {
            detectedBpm = Math.round(midi.header.tempos[0].bpm * 100) / 100; // 保留2位小数精度
        }
        if (midi.header.timeSignatures && midi.header.timeSignatures.length > 0) {
            const ts = midi.header.timeSignatures[0].timeSignature;
            detectedTsNum = ts[0];
            detectedTsDen = ts[1];
        }

        // 暂存解析结果
        _pendingMidiImport = { file, midi, lyrics, ppq, detectedBpm, detectedTsNum, detectedTsDen };

        // 填入弹窗并显示
        dom.midiImportBpm.value = detectedBpm;
        dom.midiImportTsNum.value = detectedTsNum;
        dom.midiImportTsDen.value = detectedTsDen;
        dom.midiImportModal.style.display = 'flex';
    } catch (err) {
        console.error('MIDI 解析失败:', err);
    }
}

function applyMidiImport() {
    if (!_pendingMidiImport) return;
    const { file, midi, lyrics, ppq } = _pendingMidiImport;

    // 从弹窗读取用户确认/修改后的值
    const bpm = clamp(parseFloat(dom.midiImportBpm.value) || 120, 20, 300);
    const tsNum = clamp(parseInt(dom.midiImportTsNum.value) || 4, 1, 16);
    const tsDen = clamp(parseInt(dom.midiImportTsDen.value) || 4, 1, 16);

    // 关闭弹窗
    dom.midiImportModal.style.display = 'none';

    // 应用参数
    state.midiFile = file;
    state.midiFileName = file.name;
    state.ppq = ppq;
    state.bpm = bpm;
    state.timeSig = [tsNum, tsDen];
    dom.bpmDisplay.textContent = 'BPM: ' + state.bpm;

    // 清除旧轨道的渲染轮询定时器（防止孤儿定时器继续更新 UI）
    for (const oldTrack of state.tracks) {
        if (oldTrack._pollTimer) { clearInterval(oldTrack._pollTimer); oldTrack._pollTimer = null; }
        oldTrack.synthJobId = null;
    }
    stopRenderPolling();
    hidePrepareModal();
    // 清除待发送的编辑队列
    _pendingEdits.length = 0;
    clearTimeout(_editFlushTimer);
    _editFlushTimer = null;

    state.notes = [];
    state.tracks = [];
    state.selectedIds.clear();
    noteIdCounter = 0;
    _undoStack.length = 0;
    _redoStack.length = 0;

    // 复制 lyrics 以便消费（splice）
    const lyrCopy = lyrics.slice();

    midi.tracks.forEach((track, ti) => {
        if (track.notes.length === 0) return;
        const trackId = 'track_' + ti;
        const color = TRACK_COLORS[ti % TRACK_COLORS.length];
        const trackName = track.name ? (fixEncoding(track.name) || 'Track ' + (ti+1)) : 'Track ' + (ti+1);
        state.tracks.push({
            id: trackId, name: trackName, color,
            muted: false, solo: false,
            volume: 1.0,
            _gainNode: null,  // 懒创建的 Web Audio GainNode
            channel: track.channel !== undefined ? track.channel : ti,
            renderer: 'none',       // 'none' | 'vocal' | 'instrument'
            voicebankId: null,
            instrumentId: null,
            synthJobId: null,
            synthState: 'idle',      // 'idle' | 'preparing' | 'rendering' | 'ready'
            phraseBuffers: [],
            pitchCurve: [],
            pitchDeviation: { xs: [], ys: [] },
        });
        track.notes.forEach(n => {
            if (n.midi < MIDI_LOW || n.midi > MIDI_HIGH) return;
            const tick = Math.round(n.ticks);
            const durTick = Math.round(n.durationTicks);
            let lyric = '';
            if (lyrCopy.length > 0) {
                let best = null, bestDist = Infinity;
                for (const lyr of lyrCopy) {
                    const d = Math.abs(lyr.tick - tick);
                    if (d < bestDist) { bestDist = d; best = lyr; }
                }
                if (best && bestDist < state.ppq) {
                    lyric = best.text;
                    lyrCopy.splice(lyrCopy.indexOf(best), 1);
                }
            } else {
                lyric = 'a';
            }
            state.notes.push({
                id: ++noteIdCounter,
                trackId, midi: n.midi, tick, durTick,
                velocity: Math.round(n.velocity * 127),
                lyric, color,
            });
        });
    });

    if (state.tracks.length > 0) state.activeTrackId = state.tracks[0].id;

    resizeCanvases();
    buildRuler();
    buildTrackRuler();
    requestRedraw('all');
    renderTrackPanel();
    renderTrackTimeline();
    updateInspector();
    updateSnapDisplay();

    if (state.notes.length > 0) {
        const first = state.notes.reduce((m, n) => n.tick < m.tick ? n : m, state.notes[0]);
        const scrollX = Math.max(0, tickToX(first.tick) - 100);
        mutateScrollX(scrollX); // 状态化：timeline 立即同步，grid 等打开时同步
        // 钢琴卷帘的 Y 位置在 openPianoRoll 里设置
    }

    dom.btnSynthesize.disabled = false;

    // 重置合成状态（音高曲线由后端合成后获取，不再生成模拟数据）
    state.synthDirty = true;
    state.synthState = 'idle';
    state.synthJobId = null;
    state.pitchCurve = [];
    state.pitchDeviation = { xs: [], ys: [] };
    state.phraseBuffers = [];
    state.synthPhrases = [];
    state.phrasesTotal = 0;

    _pendingMidiImport = null;
}

function cancelMidiImport() {
    dom.midiImportModal.style.display = 'none';
    _pendingMidiImport = null;
}

// ===== SECTION 19: 缩放与平移 =====
function setZoom(newZoom, pivotClientX) {
    newZoom = clamp(newZoom, ZOOM_MIN, ZOOM_MAX);
    if (newZoom === state.zoom) return;

    // 用活跃容器 + state.scrollX 计算锚点（不依赖隐藏 DOM）
    const ac = getActiveScrollContainer();
    const vw = ac.clientWidth || 800;
    let mouseXInContent, mouseXInView;
    if (pivotClientX !== undefined) {
        const rect = ac.getBoundingClientRect();
        mouseXInView = pivotClientX - rect.left;
        mouseXInContent = mouseXInView + state.scrollX;
    } else {
        mouseXInView = vw / 2;
        mouseXInContent = state.scrollX + mouseXInView;
    }

    const ratio = newZoom / state.zoom;
    state.zoom = newZoom;
    mutateZoom();                                       // 同步重建 DOM
    mutateScrollX(mouseXInContent * ratio - mouseXInView); // 用新 scrollX 对齐锚点
    dom.zoomLevel.textContent = Math.round(state.zoom * 100) + '%';
}

function startMiddlePan(e) {
    e.preventDefault();
    state.dragging = true;
    state.dragType = 'pan';
    state.dragStartX = e.clientX;
    state.dragStartY = e.clientY;
    state._panScrollLeft = dom.gridScrollContainer.scrollLeft;
    state._panScrollTop = dom.gridScrollContainer.scrollTop;
    dom.gridScrollContainer.style.cursor = 'grabbing';
}

// ===== SECTION 20: 播放系统 (Web Audio API + 分短语) =====

/** 从当前 state.notes 构建 MIDI File 对象，用于手画音符的合成 */
/** 将整数编码为 MIDI 可变长度量 (VLQ) */
function midiVLQ(value) {
    if (value < 0) value = 0;
    const bytes = [value & 0x7F];
    value >>= 7;
    while (value > 0) {
        bytes.push((value & 0x7F) | 0x80);
        value >>= 7;
    }
    bytes.reverse();
    return bytes;
}

/** 从音符数组构建包含歌词的 MIDI 二进制 */
function encodeMidiWithLyrics(notes, bpm, timeSig) {
    const PPQ = MIDI_LIB_PPQ;
    const scale = MIDI_LIB_PPQ / state.ppq;
    const enc = new TextEncoder();

    // 收集所有事件 {tick, order, bytes}
    // order: 同 tick 时，小值先输出（meta < lyric < note-on < note-off）
    const events = [];

    // Tempo: FF 51 03 tt tt tt
    const uspq = Math.round(60000000 / bpm);
    events.push({ tick: 0, order: 0, bytes: [0xFF, 0x51, 0x03, (uspq >> 16) & 0xFF, (uspq >> 8) & 0xFF, uspq & 0xFF] });

    // Time signature: FF 58 04 nn dd cc bb
    const [num, den] = timeSig;
    events.push({ tick: 0, order: 0, bytes: [0xFF, 0x58, 0x04, num, Math.round(Math.log2(den)), 24, 8] });

    for (const n of notes) {
        const tick = Math.round(n.tick * scale);
        const dur = Math.max(1, Math.round(n.durTick * scale));
        const vel = clamp(n.velocity || 80, 1, 127);

        // Lyric meta event: FF 05 len text
        const lyricBytes = enc.encode(n.lyric || 'a');
        events.push({ tick, order: 1, bytes: [0xFF, 0x05, ...midiVLQ(lyricBytes.length), ...lyricBytes] });

        // Note-on: 90 pitch vel
        events.push({ tick, order: 2, bytes: [0x90, n.midi, vel] });

        // Note-off: 80 pitch 00
        events.push({ tick: tick + dur, order: 3, bytes: [0x80, n.midi, 0] });
    }

    // End of track: FF 2F 00
    const maxTick = events.reduce((m, e) => Math.max(m, e.tick), 0);
    events.push({ tick: maxTick, order: 9, bytes: [0xFF, 0x2F, 0x00] });

    // 排序：按 tick，同 tick 按 order
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);

    // 序列化 track data（delta time + event bytes）
    const trackData = [];
    let prevTick = 0;
    for (const evt of events) {
        trackData.push(...midiVLQ(evt.tick - prevTick));
        trackData.push(...evt.bytes);
        prevTick = evt.tick;
    }

    // 组装完整 MIDI 文件
    const result = [];
    // MThd
    result.push(0x4D, 0x54, 0x68, 0x64); // "MThd"
    result.push(0, 0, 0, 6);
    result.push(0, 0);                     // format 0
    result.push(0, 1);                     // 1 track
    result.push((PPQ >> 8) & 0xFF, PPQ & 0xFF);
    // MTrk
    result.push(0x4D, 0x54, 0x72, 0x6B); // "MTrk"
    const len = trackData.length;
    result.push((len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF);
    result.push(...trackData);

    return new Uint8Array(result);
}

/** 只取指定轨道的音符构建 MIDI 文件（含歌词） */
function buildMidiForTrack(trackId) {
    const trackNotes = state.notes.filter(n => n.trackId === trackId);
    if (trackNotes.length === 0) return null;
    const sorted = trackNotes.slice().sort((a, b) => a.tick - b.tick);
    const bytes = encodeMidiWithLyrics(sorted, state.bpm, state.timeSig);
    const track = state.tracks.find(tr => tr.id === trackId);
    const name = track ? track.name : trackId;
    return new File([bytes], name + '.mid', { type: 'audio/midi' });
}

/** 对单条人声轨道发起合成 */
async function synthesizeTrack(trackId) {
    const track = state.tracks.find(t => t.id === trackId);
    if (!track || track.renderer !== 'vocal') return;

    const singerId = track.voicebankId || dom.voicebankSelect.value;
    if (!singerId) {
        console.warn('[synth] 轨道', track.name, '没有声库');
        return;
    }
    if (track.synthState === 'preparing' || track.synthState === 'rendering') return;

    const midiFile = buildMidiForTrack(trackId);
    if (!midiFile) return;

    track.synthState = 'preparing';
    track.phraseBuffers = [];
    track.pitchCurve = [];

    showPrepareModal();
    updatePrepareModalText('准备 ' + track.name + '...');

    try {
        const fd = new FormData();
        fd.append('midi', midiFile);
        fd.append('singerId', singerId);
        const res = await fetch(API_BASE + '/api/synthesize', { method: 'POST', body: fd });
        const data = await res.json();
        track.synthJobId = data.jobId;

        // 轮询准备阶段
        await waitForTrackPrepare(track);

        hidePrepareModal();
        track.synthState = 'rendering';

        // 获取音高曲线
        fetchTrackPitchCurve(track);

        // 开始轮询渲染
        startTrackRenderPolling(track);
    } catch (err) {
        hidePrepareModal();
        track.synthState = 'idle';
        track.synthJobId = null;
        console.error('[synth] 轨道', track.name, '合成失败:', err);
    }
}

function waitForTrackPrepare(track) {
    return new Promise((resolve, reject) => {
        const poll = async () => {
            // 如果轨道已被清除（重新导入），停止轮询
            if (!track.synthJobId) { reject(new Error('cancelled')); return; }
            try {
                const res = await fetch(API_BASE + '/api/jobs/' + track.synthJobId);
                const data = await res.json();
                const p = data.progress || '';
                let label = '准备 ' + track.name + '...';
                if (p.includes('Loading MIDI')) label = track.name + ': 加载 MIDI...';
                else if (p.includes('Phonemizing')) label = track.name + ': 音素化...';
                else if (p.startsWith('Predicting pitch')) {
                    const m = p.match(/\((\d+)\/(\d+)\)/);
                    label = m ? `${track.name}: 音高预测 (${m[1]}/${m[2]})` : track.name + ': 音高预测...';
                }
                updatePrepareModalText(label);

                if (data.status === 'failed') { reject(new Error(data.error)); return; }
                if (data.phrases && data.phrases.length > 0) {
                    track._synthPhrases = data.phrases;
                    track._phrasesTotal = data.phrases.length;
                    resolve(); return;
                }
                if (data.status === 'rendering' || data.status === 'completed') {
                    if (data.phrases) {
                        track._synthPhrases = data.phrases;
                        track._phrasesTotal = data.phrases.length;
                    }
                    resolve(); return;
                }
                setTimeout(poll, 500);
            } catch (err) { setTimeout(poll, 1000); }
        };
        poll();
    });
}

async function fetchTrackPitchCurve(track) {
    try {
        const resp = await fetch(`${API_BASE}/api/jobs/${track.synthJobId}/pitch`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.pitchCurve && data.pitchCurve.length > 0) {
            // 后端返回的 tick 在 MIDI 文件的 PPQ 空间（480），需缩放回 state.ppq
            const scale = state.ppq / MIDI_LIB_PPQ; // e.g. 960/480 = 2
            const newCurve = data.pitchCurve.map(p => ({
                tick: Math.round(p.tick * scale),
                pitch: p.pitch,
            }));
            track.pitchCurve = newCurve;
        }
        if (data.pitchDeviation) {
            // xs 也在 MIDI 文件 PPQ 空间，需要缩放
            const devScale = state.ppq / MIDI_LIB_PPQ;
            // 原地更新：保持对象引用不变，pitdSet 的修改不会丢失
            const dev = track.pitchDeviation || (track.pitchDeviation = { xs: [], ys: [] });
            dev.xs.length = 0;
            dev.ys.length = 0;
            const newXs = (data.pitchDeviation.xs || []).map(x => Math.round(x * devScale));
            const newYs = data.pitchDeviation.ys || [];
            for (let i = 0; i < newXs.length; i++) {
                dev.xs.push(newXs[i]);
                dev.ys.push(newYs[i]);
            }
        }
        requestRedraw('overlay');
    } catch (err) {}
}

function startTrackRenderPolling(track) {
    if (track._pollTimer) clearInterval(track._pollTimer);
    const pollFn = async () => {
        if (!track.synthJobId) { clearInterval(track._pollTimer); return; }
        try {
            const res = await fetch(API_BASE + '/api/jobs/' + track.synthJobId);
            const data = await res.json();
            if (data.phrases) {
                track._synthPhrases = data.phrases;
                track._phrasesTotal = data.phrases.length;
                // 更新渲染进度显示
                const done = data.phrases.filter(p => p.status === 'completed').length;
                const total = data.phrases.length;
                // 更新按钮文本显示进度
                if (dom.btnTrackSynth && track.id === state.activeTrackId) {
                    dom.btnTrackSynth.textContent = '渲染中 ' + done + '/' + total;
                }
                for (const p of data.phrases) {
                    if (p.status === 'completed'
                        && !track.phraseBuffers.some(b => b.index === p.index)
                        && !state._fetchingPhrases.has(track.synthJobId + ':' + p.index)) {
                        fetchTrackPhraseAudio(track, p);
                    }
                }
            }
            // 渲染中持续刷新音高曲线（占位数据 → 真正预测值）
            // ready 之后不再覆盖（用户可能已编辑 pitchDeviation）
            if (track.synthState !== 'ready') {
                fetchTrackPitchCurve(track);
            }
            if (data.status === 'completed') {
                clearInterval(track._pollTimer);
                track.synthState = 'ready';
                // 恢复按钮文本
                if (dom.btnTrackSynth && track.id === state.activeTrackId) {
                    dom.btnTrackSynth.textContent = '合成';
                }
                // 最终再拉一次音高曲线确保完整
                fetchTrackPitchCurve(track);
                // 触发 UI 刷新：音高曲线显示 + 播放系统识别到 ready
                requestRedraw('overlay');
                renderTrackPanel();
                // 如果正在播放，重新调度以包含所有 buffer
                if (state.playing) {
                    reschedulePlayback();
                }
            }
            if (data.status === 'failed') {
                clearInterval(track._pollTimer);
                track.synthState = 'idle';
                track.synthJobId = null;
                if (dom.btnTrackSynth && track.id === state.activeTrackId) {
                    dom.btnTrackSynth.textContent = '合成';
                }
                renderTrackPanel();
            }
        } catch (err) { console.warn('[poll] error:', err); }
    };
    pollFn();
    track._pollTimer = setInterval(pollFn, 500);
}

async function fetchTrackPhraseAudio(track, phraseInfo) {
    const fetchKey = track.synthJobId + ':' + phraseInfo.index;
    state._fetchingPhrases.add(fetchKey);
    try {
        const ctx = ensureAudioCtx();
        const url = API_BASE + '/api/jobs/' + track.synthJobId + '/phrases/' + phraseInfo.index;
        const res = await fetch(url);
        if (!res.ok) { console.warn('[audio] fetch phrase', phraseInfo.index, 'failed:', res.status); return; }
        const arrayBuf = await res.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuf);
        track.phraseBuffers.push({
            index: phraseInfo.index,
            startMs: phraseInfo.startMs,
            durationMs: phraseInfo.durationMs,
            audioBuffer,
        });
        // 如果正在播放，立即将新 buffer 加入当前播放调度
        if (state.playing) {
            scheduleSinglePhrase(track.phraseBuffers[track.phraseBuffers.length - 1], track);
        }
        // 如果正在等待这个短语 → 恢复播放
        if (state.pendingPlay && state.waitingForPhrase === phraseInfo.index) {
            beginActualPlayback();
        }
    } catch (err) { console.warn('[audio] decode phrase', phraseInfo.index, 'error:', err); }
    finally { state._fetchingPhrases.delete(fetchKey); }
}

// ===== 采样器初始化 =====
function initPianoSampler() {
    getInstrumentSampler('piano');
}

function ensureAudioCtx() {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    return state.audioCtx;
}

// ===== 人声卷积混响（发送-返回） =====
// vocalBus → destination （干声直通）
// vocalBus → vocalSendGain → vocalConvolver → destination （湿声）
let _vocalBus = null;       // 所有人声 source 连接到此
let _vocalSendGain = null;
let _vocalConvolver = null;
let _vocalReverbEnabled = false;
let _vocalCurrentIR = null;

function getVocalBus() {
    const ctx = ensureAudioCtx();
    if (_vocalBus) return _vocalBus;

    _vocalBus = ctx.createGain();
    _vocalSendGain = ctx.createGain();
    _vocalConvolver = ctx.createConvolver();

    // 干声直通
    _vocalBus.connect(ctx.destination);
    // 发送-返回
    _vocalBus.connect(_vocalSendGain);
    _vocalSendGain.connect(_vocalConvolver);
    _vocalConvolver.connect(ctx.destination);

    // 默认关闭
    _vocalSendGain.gain.value = 0;
    return _vocalBus;
}

/** 获取轨道的音量 GainNode（懒创建），连接到 vocalBus */
function getTrackGainNode(track) {
    if (track._gainNode) return track._gainNode;
    const ctx = ensureAudioCtx();
    track._gainNode = ctx.createGain();
    track._gainNode.gain.value = track.volume;
    track._gainNode.connect(getVocalBus());
    return track._gainNode;
}

async function loadVocalIR(irName) {
    const ctx = ensureAudioCtx();
    if (!_vocalConvolver) getVocalBus();
    try {
        const res = await fetch(`../samples/ir/${irName}.mp3`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await ctx.decodeAudioData(arrayBuf);
        _vocalConvolver.buffer = audioBuf;
        _vocalCurrentIR = irName;
    } catch (err) {
        console.error('Vocal IR load failed:', irName, err);
    }
}

function applyVocalReverbState() {
    if (!_vocalSendGain) return;
    if (_vocalReverbEnabled) {
        const el = document.getElementById('vocalReverbSend');
        _vocalSendGain.gain.value = (el ? parseInt(el.value, 10) : 55) / 100;
    } else {
        _vocalSendGain.gain.value = 0;
    }
}

function togglePlay() {
    if (state.playing || state.pendingPlay) {
        pausePlayback();
    } else {
        startPlayback();
    }
}

async function startPlayback() {
    // 如果有待发送的音符编辑，立即 flush（必须 await 确保后端已收到编辑再继续）
    if (_pendingEdits.length > 0) {
        await flushNoteEdits();
    }

    if (state.notes.length === 0) return;

    // 确保 Tone.js AudioContext 可用
    if (typeof Tone !== 'undefined' && Tone.context.state !== 'running') {
        Tone.start();
    }

    state._autoFollow = true;
    ensureAudioCtx();
    state.playStartTime = state.playheadTime;

    // 检查当前播放头位置是否有未渲染的短语需要等待
    const phrases = getActiveSynthPhrases();
    if (phrases.length > 0) {
        const phraseAtCursor = findPhraseAtTime(state.playheadTime);
        const target = phraseAtCursor || findNextPhraseAfter(state.playheadTime);
        if (target && !isPhraseBuffered(target.index)) {
            // 需要等待的短语还没渲染好 → 进入黄色等待
            enterWaitingState(target.index);
            return;
        }
    }

    // 直接开始播放：
    // - 已合成的人声轨道 → 播放合成音频（由 scheduleAllPhrases 处理）
    // - 其余所有轨道 → 钢琴采样播放（由 scheduleInstrumentTracks 处理）
    beginActualPlayback();
}

/** 获取当前活跃的合成短语列表（per-track 或 global） */
function getActiveSynthPhrases() {
    if (state.activeTrackId && !dom.pianoRoll.classList.contains('hidden')) {
        const track = state.tracks.find(t => t.id === state.activeTrackId);
        // 只有轨道有独立 synthJobId 时才用 per-track phrases
        if (track && track.synthJobId && track._synthPhrases && track._synthPhrases.length > 0) return track._synthPhrases;
    }
    return state.synthPhrases;
}

/** 获取当前活跃的已解码 buffer 列表（per-track 或 global） */
function getActivePhraseBuffers() {
    if (state.activeTrackId && !dom.pianoRoll.classList.contains('hidden')) {
        const track = state.tracks.find(t => t.id === state.activeTrackId);
        // 只有当轨道有独立的 synthJobId 时才用 per-track buffer
        // 否则 fallthrough 到全局 buffer（autoSynthesize 走的全局路径）
        if (track && track.synthJobId && track.phraseBuffers) return track.phraseBuffers;
    }
    return state.phraseBuffers;
}

/** 找到播放头时间所在的短语（如果在某个短语的时间范围内） */
function findPhraseAtTime(timeSec) {
    const timeMs = timeSec * 1000;
    const phrases = getActiveSynthPhrases();
    return phrases.find(p =>
        timeMs >= p.startMs && timeMs < p.startMs + p.durationMs
    ) || null;
}

/** 找到时间点之后最近的短语 */
function findNextPhraseAfter(timeSec) {
    const timeMs = timeSec * 1000;
    const phrases = getActiveSynthPhrases();
    let best = null;
    for (const p of phrases) {
        if (p.startMs >= timeMs) {
            if (!best || p.startMs < best.startMs) best = p;
        }
    }
    return best;
}

/** 检查某个短语是否已经被解码到 phraseBuffers 中 */
function isPhraseBuffered(index) {
    const buffers = getActivePhraseBuffers();
    return buffers.some(b => b.index === index);
}

/** 进入等待状态：播放头卡住变色，请求后端优先渲染 */
function enterWaitingState(phraseIndex) {
    state.pendingPlay = true;
    state.waitingForPhrase = phraseIndex;
    dom.btnPlay.classList.remove('fa-play');
    dom.btnPlay.classList.add('fa-pause', 'playing');
    setPlayheadWaiting(true);

    // 请求后端优先渲染这个短语（支持 per-track 和 global）
    const jobId = getActiveJobId();
    if (jobId) {
        fetch(API_BASE + '/api/jobs/' + jobId + '/priority', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phraseIndex }),
        }).catch(() => {});
    }

    // 安全网：定时检查等待的短语是否已到位，防止回调链断裂导致永远卡死
    startWaitingPoll();
}

let _waitingPollTimer = null;
function startWaitingPoll() {
    clearInterval(_waitingPollTimer);
    _waitingPollTimer = setInterval(() => {
        if (!state.pendingPlay) {
            clearInterval(_waitingPollTimer);
            _waitingPollTimer = null;
            return;
        }
        // 检查等待的短语是否已经在 buffer 中了
        if (isPhraseBuffered(state.waitingForPhrase)) {
            clearInterval(_waitingPollTimer);
            _waitingPollTimer = null;
            beginActualPlayback();
            return;
        }
        // 如果短语不在 buffer 中，也没人在下载它，主动去后端拉取
        // （前端 invalidateAffectedBuffers 估算范围可能比后端 affectedIndices 大，
        //   导致 buffer 被删但没人重新下载）
        const jobId = getActiveJobId();
        const st = getActiveSynthTrack();
        const fetchKey = jobId + ':' + state.waitingForPhrase;
        if (jobId && !state._fetchingPhrases.has(fetchKey)) {
            const phrases = getActiveSynthPhrases();
            const info = phrases.find(p => p.index === state.waitingForPhrase);
            if (info) {
                console.log('[waitingPoll] phrase', state.waitingForPhrase, 'not being fetched, triggering download');
                if (st) {
                    fetchTrackPhraseAudio(st, info);
                } else {
                    fetchPhraseAudio(info);
                }
            }
        }
    }, 300);
}

/** 设置播放头等待/正常颜色 */
function setPlayheadWaiting(waiting) {
    if (waiting) {
        dom.playhead.classList.add('waiting');
    } else {
        dom.playhead.classList.remove('waiting');
    }
}

function beginActualPlayback() {
    ensureAudioCtx();
    if (typeof Tone !== 'undefined' && Tone.context.state !== 'running') Tone.start();
    state.playing = true;
    state.pendingPlay = false;
    state.waitingForPhrase = -1;
    setPlayheadWaiting(false);
    clearInterval(_waitingPollTimer); _waitingPollTimer = null;
    dom.btnPlay.classList.remove('fa-play');
    dom.btnPlay.classList.add('fa-pause', 'playing');

    scheduleAllPhrases(state.playheadTime);

    state._playStartWall = performance.now() - state.playheadTime * 1000;
    state.animFrameId = requestAnimationFrame(animatePlayback);
}

function scheduleAllPhrases(fromTimeSec) {
    // 先清除旧的调度
    stopAllSources();

    const ctx = state.audioCtx;
    if (!ctx) return;
    const now = ctx.currentTime;

    const playable = getPlayableTracks();

    // 收集可播放轨道的合成短语 buffer（带 track 引用，用于音量控制）
    // 如果钢琴卷帘打开且轨道有独立 synthJobId，只用 per-track buffer
    // 否则用全局 buffer + 各轨道的 per-track buffer
    const allBuffers = [];
    const pianoOpen = state.activeTrackId && !dom.pianoRoll.classList.contains('hidden');
    const activeTrack = pianoOpen ? state.tracks.find(t => t.id === state.activeTrackId) : null;
    const usePerTrackOnly = activeTrack && activeTrack.synthJobId;

    if (!usePerTrackOnly) {
        // 全局 buffer 没有特定 track，连 vocalBus
        state.phraseBuffers.forEach(b => allBuffers.push({ buf: b, track: null }));
    }
    playable.forEach(t => {
        if (t.renderer === 'vocal' && t.phraseBuffers && t.phraseBuffers.length > 0) {
            t.phraseBuffers.forEach(b => allBuffers.push({ buf: b, track: t }));
        }
    });

    allBuffers.forEach(({ buf: p, track: t }) => {
        if (!p.audioBuffer) return;
        const phraseStartSec = p.startMs / 1000;
        const phraseDurSec = p.durationMs / 1000;
        const phraseEndSec = phraseStartSec + phraseDurSec;

        // 短语已经完全播放过了
        if (phraseEndSec <= fromTimeSec) return;

        const source = ctx.createBufferSource();
        source.buffer = p.audioBuffer;
        // 有 track → 走 track GainNode（音量控制）→ vocalBus
        // 无 track（全局 buffer）→ 直连 vocalBus
        source.connect(t ? getTrackGainNode(t) : getVocalBus());

        // 计算这个短语在 AudioContext 时间轴上什么时候开始播放
        const delayFromNow = phraseStartSec - fromTimeSec;

        if (delayFromNow >= 0) {
            // 短语还没到播放时间 → 延迟开始
            source.start(now + delayFromNow);
        } else {
            // 短语已经开始了一部分 → 从中间开始播放
            const offset = -delayFromNow; // 跳过的秒数
            if (offset < p.audioBuffer.duration) {
                source.start(now, offset);
            }
        }

        state.scheduledSources.push(source);
    });

    // 同时调度乐器轨道
    scheduleInstrumentTracks(fromTimeSec);
}

function scheduleSinglePhrase(phrase, track) {
    const ctx = state.audioCtx;
    if (!ctx || !state.playing) return;
    if (!phrase.audioBuffer) return;

    const now = ctx.currentTime;
    // 用和 animatePlayback 一样的方式计算当前播放时间
    const currentPlayTime = (performance.now() - state._playStartWall) / 1000;

    const phraseStartSec = phrase.startMs / 1000;
    const phraseEndSec = phraseStartSec + phrase.durationMs / 1000;

    if (phraseEndSec <= currentPlayTime) return; // 已过

    const source = ctx.createBufferSource();
    source.buffer = phrase.audioBuffer;
    source.connect(track ? getTrackGainNode(track) : getVocalBus());

    const delayFromNow = phraseStartSec - currentPlayTime;
    if (delayFromNow >= 0) {
        source.start(now + delayFromNow);
    } else {
        const offset = -delayFromNow;
        if (offset < phrase.audioBuffer.duration) {
            source.start(now, offset);
        }
    }
    state.scheduledSources.push(source);
}

function stopAllSources() {
    state.scheduledSources.forEach(s => {
        try { s.stop(); } catch {}
    });
    state.scheduledSources = [];
    stopPianoQueue();
}

function cancelPendingPlay() {
    state.pendingPlay = false;
    state.waitingForPhrase = -1;
    setPlayheadWaiting(false);
    clearInterval(_waitingPollTimer); _waitingPollTimer = null;
    dom.btnPlay.classList.remove('fa-pause', 'playing');
    dom.btnPlay.classList.add('fa-play');
}

function pausePlayback() {
    state.playing = false;
    state.pendingPlay = false;
    state.waitingForPhrase = -1;
    state.playingNoteIds.clear();
    setPlayheadWaiting(false);
    clearInterval(_waitingPollTimer); _waitingPollTimer = null;
    dom.btnPlay.classList.remove('fa-pause', 'playing');
    dom.btnPlay.classList.add('fa-play');
    stopAllSources();
    if (state.animFrameId) { cancelAnimationFrame(state.animFrameId); state.animFrameId = null; }
    requestRedraw('notes');
}

function stopPlayback() {
    pausePlayback();
    state.playheadTime = state.playStartTime;
    updatePlayheadPos();
    dom.timeDisplay.textContent = formatTime(state.playheadTime);
}

/** 播放中重新调度（mute/solo/轨道变化时调用） */
function reschedulePlayback() {
    if (!state.playing) return;
    state._playStartWall = performance.now() - state.playheadTime * 1000;
    scheduleAllPhrases(state.playheadTime);
}

function seekTo(time) {
    state.playheadTime = Math.max(0, time);
    if (state.playing) {
        reschedulePlayback();
    }
    updatePlayheadPos();
    dom.timeDisplay.textContent = formatTime(state.playheadTime);
}

function animatePlayback() {
    if (!state.playing) return;
    state.playheadTime = (performance.now() - state._playStartWall) / 1000;
    updatePlayheadPos();
    dom.timeDisplay.textContent = formatTime(state.playheadTime);
    autoScrollPlayhead();
    updatePlayingNotes();
    // 渐进调度钢琴音符
    tickPianoPlayback(state.playheadTime);

    // 检查播放头是否走到了未渲染的短语区域
    const phraseAtCursor = findPhraseAtTime(state.playheadTime);
    let needWaitPhrase = null;

    if (phraseAtCursor && !isPhraseBuffered(phraseAtCursor.index)) {
        needWaitPhrase = phraseAtCursor;
    } else if (!phraseAtCursor) {
        // 播放头在间隙中 → 检查下一个短语是否已渲染
        const next = findNextPhraseAfter(state.playheadTime);
        if (next && !isPhraseBuffered(next.index)) {
            // 如果下一个短语即将到来且未渲染，预先暂停等待
            const gapMs = next.startMs - state.playheadTime * 1000;
            if (gapMs < 500) {
                needWaitPhrase = next;
            }
        }
    }

    if (needWaitPhrase) {
        // 暂停播放，等待这个短语渲染完成
        stopAllSources();
        state.playing = false;
        state.pendingPlay = true;
        state.waitingForPhrase = needWaitPhrase.index;
        state.playStartTime = state.playheadTime;
        setPlayheadWaiting(true);
        if (state.animFrameId) { cancelAnimationFrame(state.animFrameId); state.animFrameId = null; }

        // 请求后端优先渲染（支持 per-track 和 global）
        const jobId = getActiveJobId();
        if (jobId) {
            fetch(API_BASE + '/api/jobs/' + jobId + '/priority', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phraseIndex: needWaitPhrase.index }),
            }).catch(() => {});
        }

        // 安全网：定时检查等待的短语是否已到位
        startWaitingPoll();
        return;
    }

    state.animFrameId = requestAnimationFrame(animatePlayback);
}

function updatePlayingNotes() {
    const currentTick = timeToTick(state.playheadTime);
    const newPlaying = new Set();
    const visibleTrackIds = getVisibleTrackIds();
    for (const n of state.notes) {
        if (!visibleTrackIds.has(n.trackId)) continue;
        if (currentTick >= n.tick && currentTick < n.tick + n.durTick) {
            newPlaying.add(n.id);
        }
    }
    let changed = newPlaying.size !== state.playingNoteIds.size;
    if (!changed) {
        for (const id of newPlaying) {
            if (!state.playingNoteIds.has(id)) { changed = true; break; }
        }
    }
    if (changed) {
        state.playingNoteIds = newPlaying;
        requestRedraw('notes');
    }
}

function updatePlayheadPos() {
    const tick = timeToTick(state.playheadTime);
    const x = tickToX(tick);
    dom.playhead.style.left = (x - 7) + 'px';
    dom.playhead.style.top = '0px';
    updateTimelinePlayhead();
}

function autoScrollPlayhead() {
    if (!state._autoFollow) return;
    const x = tickToX(timeToTick(state.playheadTime));
    const ac = getActiveScrollContainer();
    const vw = ac.clientWidth || 800;
    const viewLeft = state.scrollX;
    const viewRight = viewLeft + vw;
    const margin = vw * 0.15;
    state._autoScrolling = true;
    if (x > viewRight - margin) {
        const target = x - vw * 0.3;
        mutateScrollX(state.scrollX + (target - state.scrollX) * 0.25);
    } else if (x < viewLeft) {
        mutateScrollX(x - vw * 0.1);
    }
    syncPianoScroll();
    state._autoScrolling = false;
}

// ===== SECTION 21: 轨道面板 =====
function renderTrackPanel() {
    dom.trackHeaderCol.innerHTML = '';
    if (state.tracks.length === 0) {
        dom.trackHeaderCol.innerHTML = '<div class="track-empty-hint"><i class="fas fa-music"></i> 打开 MIDI 文件以加载轨道</div>';
        return;
    }
    state.tracks.forEach(track => {
        const item = document.createElement('div');
        item.className = 'track-item' + (track.id === state.activeTrackId ? ' active' : '');

        // 渲染器图标
        let iconClass = '';
        let iconHtml = '';
        if (track.renderer === 'vocal') {
            iconClass = 'vocal';
            iconHtml = '<i class="fas fa-microphone-alt"></i>';
        } else if (track.renderer === 'instrument') {
            iconClass = 'instrument';
            iconHtml = '<i class="fas fa-music"></i>';
        } else {
            iconHtml = '<i class="fas fa-circle" style="font-size:6px"></i>';
        }

        item.innerHTML = `
            <span class="track-renderer-icon ${iconClass}" data-track="${track.id}" title="配置渲染器">${iconHtml}</span>
            <span class="track-name">${track.name}</span>
            <span class="track-channel">CH${track.channel}</span>
            <input type="range" class="track-volume" data-track="${track.id}" min="0" max="100" value="${Math.round(track.volume * 100)}" title="音量 ${Math.round(track.volume * 100)}%">
            <div class="track-btns">
                <button class="track-btn ${track.muted?'mute-active':''}" data-action="mute" data-track="${track.id}">M</button>
                <button class="track-btn ${track.solo?'solo-active':''}" data-action="solo" data-track="${track.id}">S</button>
            </div>`;
        // 音量滑条：实时调节，播放中立即生效
        const volSlider = item.querySelector('.track-volume');
        volSlider.addEventListener('input', e => {
            e.stopPropagation();
            track.volume = parseInt(e.target.value, 10) / 100;
            e.target.title = '音量 ' + e.target.value + '%';
            // 人声轨道：实时更新 GainNode
            if (track._gainNode) {
                track._gainNode.gain.value = track.volume;
            }
        });
        volSlider.addEventListener('click', e => e.stopPropagation());
        volSlider.addEventListener('dblclick', e => e.stopPropagation());
        item.addEventListener('click', e => {
            // 滑条点击不触发轨道选中
            if (e.target.closest('.track-volume')) return;
            // 渲染器图标点击 → 打开/切换左侧面板
            if (e.target.closest('.track-renderer-icon')) {
                const clickedTrackId = e.target.closest('.track-renderer-icon').dataset.track;
                toggleTrackInspector(clickedTrackId);
                return;
            }
            if (e.target.closest('.track-btn')) {
                const btn = e.target.closest('.track-btn');
                const action = btn.dataset.action;
                if (action === 'mute') mutateTrack(track.id, { muted: !track.muted });
                if (action === 'solo') mutateTrack(track.id, { solo: !track.solo });
                return;
            }
            state.activeTrackId = track.id;
            renderTrackPanel();
        });
        // 双击轨道项 → 打开钢琴卷帘
        item.addEventListener('dblclick', e => {
            if (e.target.closest('.track-renderer-icon') || e.target.closest('.track-btn')) return;
            openPianoRoll(track.id);
        });
        dom.trackHeaderCol.appendChild(item);
    });
}

function renderTrackTimeline() {
    dom.trackTimeline.innerHTML = '';

    // 计算全局时间轴宽度（与钢琴卷帘一致）
    let maxTick = 200 * state.ppq;
    if (state.notes.length > 0) {
        const last = state.notes.reduce((m, n) => Math.max(m, n.tick + n.durTick), 0);
        maxTick = Math.max(maxTick, last + 16 * state.ppq);
    }
    const totalWidth = Math.ceil(tickToX(maxTick));
    const totalHeight = Math.max(state.tracks.length * 50, 120);

    // 撑开滚动区域的占位容器
    const spacer = document.createElement('div');
    spacer.className = 'timeline-spacer';
    spacer.style.cssText = `position:relative;width:${totalWidth}px;height:${totalHeight}px;`;
    dom.trackTimeline.appendChild(spacer);

    state.tracks.forEach((track, i) => {
        const notes = state.notes.filter(n => n.trackId === track.id);
        const blockTop = i * 50 + 2;
        const blockHeight = 46;

        // 轨道行背景
        const row = document.createElement('div');
        row.className = 'track-block';
        row.style.left = '0';
        row.style.width = totalWidth + 'px';
        row.style.top = blockTop + 'px';
        row.style.height = blockHeight + 'px';
        row.style.background = track.color + '0a';
        row.style.border = 'none';
        row.style.borderBottom = '1px solid ' + track.color + '18';

        if (notes.length > 0) {
            // 用 Canvas 绘制缩略音符（迷你钢琴卷帘风格）
            const CANVAS_MAX_W = 16384;
            const canvas = document.createElement('canvas');
            const canvasW = Math.min(totalWidth, CANVAS_MAX_W);
            canvas.width = canvasW;
            canvas.height = blockHeight;
            canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
            const c = canvas.getContext('2d');
            if (totalWidth > CANVAS_MAX_W) c.scale(canvasW / totalWidth, 1);

            const allMidi = notes.map(n => n.midi);
            const minMidi = Math.min(...allMidi) - 2;
            const maxMidi = Math.max(...allMidi) + 2;
            const midiRange = Math.max(maxMidi - minMidi, 1);
            const padding = 4;
            const innerH = blockHeight - padding * 2;

            c.fillStyle = track.color;
            c.globalAlpha = 0.8;
            notes.forEach(n => {
                const x = tickToX(n.tick);
                const w = Math.max(tickToX(n.tick + n.durTick) - x, 2);
                const y = padding + (1 - (n.midi - minMidi) / midiRange) * innerH;
                const h = Math.max(innerH / midiRange, 1.5);
                c.fillRect(x, y - h / 2, w, h);
            });

            row.appendChild(canvas);
        }

        row.addEventListener('dblclick', () => openPianoRoll(track.id));
        row.style.cursor = 'pointer';
        spacer.appendChild(row);
    });

    // 播放头（在 spacer 内，跟随滚动）
    const ph = document.createElement('div');
    ph.className = 'timeline-playhead';
    spacer.appendChild(ph);
    updateTimelinePlayhead();
    // DOM 重建后恢复滚动位置
    dom.trackTimeline.scrollLeft = state.scrollX;
}

/** 更新轨道时间线播放头位置 */
function updateTimelinePlayhead() {
    const ph = dom.trackTimeline.querySelector('.timeline-playhead');
    if (!ph) return;
    const tick = timeToTick(state.playheadTime);
    const x = tickToX(tick);
    ph.style.left = x + 'px';
}

// ===== SECTION 21b: 左侧轨道配置面板 =====

function toggleTrackInspector(trackId) {
    if (state.configTrackId === trackId && dom.trackInspector.style.display !== 'none') {
        // 再次点击同一轨道 → 关闭面板
        closeTrackInspector();
        return;
    }
    state.configTrackId = trackId;
    dom.trackInspector.style.display = 'flex';
    updateTrackInspector();
}

function closeTrackInspector() {
    state.configTrackId = null;
    dom.trackInspector.style.display = 'none';
}

function updateTrackInspector() {
    const track = state.tracks.find(t => t.id === state.configTrackId);
    if (!track) { closeTrackInspector(); return; }

    // 标题
    dom.trackInspectorName.textContent = track.name;

    // 渲染器 radio
    const radios = dom.rendererOptions.querySelectorAll('input[name="trackRenderer"]');
    radios.forEach(r => { r.checked = (r.value === track.renderer); });

    // 显示/隐藏声库或乐器 section
    dom.vocalSection.style.display = track.renderer === 'vocal' ? '' : 'none';
    dom.instrumentSection.style.display = track.renderer === 'instrument' ? '' : 'none';

    // 填充声库列表
    if (track.renderer === 'vocal') {
        populateTrackVoicebankList(track);
    }

    // 乐器选择
    if (track.renderer === 'instrument') {
        dom.trackInstrumentSelect.value = track.instrumentId || 'piano';
    }
}

function populateTrackVoicebankList(track) {
    dom.trackVoicebankList.innerHTML = '';
    // 从右侧 voicebankSelect 获取已加载的声库列表
    const options = dom.voicebankSelect.querySelectorAll('option');
    options.forEach(opt => {
        if (!opt.value) return; // 跳过 placeholder
        const item = document.createElement('div');
        item.className = 'voicebank-item' + (track.voicebankId === opt.value ? ' selected' : '');
        item.textContent = opt.textContent;
        item.dataset.id = opt.value;
        item.addEventListener('click', () => {
            track.voicebankId = opt.value;
            // 更新选中状态
            dom.trackVoicebankList.querySelectorAll('.voicebank-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            // 同步右侧声库选择器
            dom.voicebankSelect.value = opt.value;
            renderTrackPanel();
        });
        dom.trackVoicebankList.appendChild(item);
    });
}

function bindTrackInspectorEvents() {
    // 关闭按钮
    dom.trackInspectorClose.addEventListener('click', closeTrackInspector);

    // 渲染器 radio 切换
    dom.rendererOptions.addEventListener('change', e => {
        const radio = e.target;
        if (radio.name !== 'trackRenderer') return;
        const track = state.tracks.find(t => t.id === state.configTrackId);
        if (!track) return;
        const changes = { renderer: radio.value };
        if (radio.value !== 'vocal') changes.voicebankId = null;
        if (radio.value !== 'instrument') changes.instrumentId = null;
        mutateTrack(state.configTrackId, changes);
        updateTrackInspector();
    });

    // 乐器选择
    dom.trackInstrumentSelect.addEventListener('change', () => {
        const track = state.tracks.find(t => t.id === state.configTrackId);
        if (!track) return;
        track.instrumentId = dom.trackInstrumentSelect.value;
        // 预加载新采样器 & 如果正在播放则立即切换
        getInstrumentSampler(track.instrumentId);
        if (state.playing) reschedulePlayback();
    });
}

// ===== SECTION 21c: 钢琴卷帘展开/收起 =====

function openPianoRoll(trackId) {
    // 如果双击的是当前已打开的轨道 → 收起钢琴卷帘
    const isOpen = !dom.pianoRoll.classList.contains('hidden');
    if (isOpen && state.activeTrackId === trackId) {
        closePianoRoll();
        return;
    }

    // 切换轨道前：flush 旧轨道的待发送编辑和音高（上下文即将变化）
    if (isOpen && state.activeTrackId && state.activeTrackId !== trackId) {
        if (_pendingEdits.length > 0) flushNoteEdits();
        clearTimeout(_pitchSendTimer); _pitchSendTimer = null;
    }

    state.activeTrackId = trackId;
    const track = state.tracks.find(t => t.id === trackId);
    dom.pianoRoll.classList.remove('hidden');
    dom.pianoRoll.parentElement.classList.remove('piano-hidden');
    dom.pianoRollTrackName.textContent = track ? track.name : '—';
    // 重置合成按钮文本（防止显示旧轨道的渲染进度）
    if (dom.btnTrackSynth) {
        dom.btnTrackSynth.textContent = (track && (track.synthState === 'rendering' || track.synthState === 'preparing'))
            ? '渲染中...' : '合成';
    }
    // 设置轨道面板固定高度（可被 resizer 拖拽调整）
    if (!dom.trackView.style.height || dom.trackView.style.height === '') {
        dom.trackView.style.height = '150px';
    }
    dom.trackView.style.flex = '0 0 auto';
    // 刷新
    renderTrackPanel();
    resizeCanvases();
    requestRedraw('all');
    // 打开时先把 grid 同步到当前 state.scrollX
    dom.gridScrollContainer.scrollLeft = state.scrollX;
    // 滚动到该轨道的音符位置
    const trackNotes = state.notes.filter(n => n.trackId === trackId);
    if (trackNotes.length > 0) {
        const first = trackNotes.reduce((m, n) => n.tick < m.tick ? n : m, trackNotes[0]);
        const scrollX = Math.max(0, tickToX(first.tick) - 100);
        const scrollY = Math.max(0, midiToY(first.midi) - dom.gridScrollContainer.clientHeight / 2);
        mutateScrollX(scrollX);
        dom.gridScrollContainer.scrollTop = scrollY + RULER_HEIGHT;
        syncPianoScroll();
    }
}

function closePianoRoll() {
    // 立即 flush 待发送的编辑（当前上下文还在 per-track 模式）
    if (_pendingEdits.length > 0) flushNoteEdits();
    // 取消挂起的音高发送定时器（防止闭包引用过时轨道）
    clearTimeout(_pitchSendTimer); _pitchSendTimer = null;

    dom.pianoRoll.classList.add('hidden');
    dom.pianoRoll.parentElement.classList.add('piano-hidden');
    dom.trackView.style.flex = '';
    dom.trackView.style.height = '';
    resizeCanvases();
    requestRedraw('all');
}

function bindPianoRollEvents() {
    dom.pianoRollClose.addEventListener('click', closePianoRoll);

    // 单轨播放按钮（钢琴卷帘打开时 getPlayableTracks 已返回单轨，直接复用 togglePlay）
    dom.btnSoloPlay.addEventListener('click', () => {
        if (!state.activeTrackId) return;
        togglePlay();
    });

    // 合成当前轨道按钮
    dom.btnTrackSynth.addEventListener('click', () => {
        if (!state.activeTrackId) return;
        const track = state.tracks.find(t => t.id === state.activeTrackId);
        if (!track) return;
        if (track.renderer !== 'vocal') {
            mutateTrack(state.activeTrackId, { renderer: 'vocal' });
        }
        synthesizeTrack(state.activeTrackId);
    });
}

// ===== SECTION 22: 检查器 =====
function updateInspector() {
    if (state.selectedIds.size === 1) {
        const id = [...state.selectedIds][0];
        const note = state.notes.find(n => n.id === id);
        if (note) {
            dom.inspectorLyrics.value = note.lyric || '';
            dom.inspectorLyrics.disabled = false;
            dom.inspectorPitch.value = midiNoteName(note.midi);
            dom.inspectorVelocity.value = note.velocity;
            return;
        }
    }
    dom.inspectorLyrics.value = '';
    dom.inspectorLyrics.disabled = (state.selectedIds.size !== 1);
    dom.inspectorPitch.value = state.selectedIds.size > 1 ? state.selectedIds.size + ' 个音符' : '-';
    dom.inspectorVelocity.value = '-';
}

// ===== SECTION 22b: 增量音符编辑 =====

// 待发送的编辑指令队列
let _pendingEdits = [];
let _editFlushTimer = null;
let _frontendInvalidatedKeys = new Set(); // 前端 invalidateAffectedBuffers 加入 _fetchingPhrases 的 key

/** 收集一条音符编辑指令（防抖 2 秒后自动发送） */
function pushNoteEdit(edit) {
    _pendingEdits.push(edit);
    // 清除受影响短语的缓冲区（让播放系统进入等待）
    invalidateAffectedBuffers(edit);
    // 如果正在播放，重新调度：旧音频立刻停止，animatePlayback 下一帧会检测到缺失并进入黄色等待
    if (state.playing) {
        const currentPlayTime = (performance.now() - state._playStartWall) / 1000;
        stopAllSources();
        scheduleAllPhrases(currentPlayTime);
    }
    // 防抖：2 秒内无新编辑则自动发送
    clearTimeout(_editFlushTimer);
    _editFlushTimer = setTimeout(() => flushNoteEdits(), 2000);
}

/** 根据编辑指令估算受影响的短语范围，清除其缓冲区 */
function invalidateAffectedBuffers(edit) {
    const st = getActiveSynthTrack();
    const phrases = st ? (st._synthPhrases || []) : state.synthPhrases;
    if (!phrases || phrases.length === 0) return;
    // 用编辑的 tick 位置估算时间，找到覆盖的短语
    const editTimeStart = tickToTime(edit.position || 0);
    const editTimeEnd = tickToTime((edit.position || 0) + (edit.duration || 0));
    // 也考虑 move 的新位置
    let t0 = editTimeStart, t1 = editTimeEnd;
    if (edit.newPosition != null) {
        const nt0 = tickToTime(edit.newPosition);
        const nt1 = tickToTime(edit.newPosition + (edit.duration || 0));
        t0 = Math.min(t0, nt0);
        t1 = Math.max(t1, nt1);
    }
    // 扩大范围（音素化可能影响相邻短语）
    t0 -= 1; t1 += 1;
    const toRemove = phrases
        .filter(p => {
            const ps = p.startMs / 1000;
            const pe = (p.startMs + p.durationMs) / 1000;
            return pe >= t0 && ps <= t1;
        })
        .map(p => p.index);
    if (toRemove.length > 0) {
        const removeSet = new Set(toRemove);
        const jobId = st ? st.synthJobId : state.synthJobId;
        if (st) {
            st.phraseBuffers = st.phraseBuffers.filter(b => !removeSet.has(b.index));
        } else {
            state.phraseBuffers = state.phraseBuffers.filter(b => !removeSet.has(b.index));
        }
        toRemove.forEach(idx => {
            const key = jobId + ':' + idx;
            state._fetchingPhrases.add(key);
            _frontendInvalidatedKeys.add(key);
        });
    }
}

/** 立即发送所有待编辑给后端 */
async function flushNoteEdits() {
    clearTimeout(_editFlushTimer);
    if (_pendingEdits.length === 0) return;
    const jobId = getActiveJobId();
    const st = getActiveSynthTrack();
    if (!jobId) return;

    const rawEdits = _pendingEdits.slice();
    _pendingEdits = [];

    // PPQ 转换：前端 state.ppq → 后端 MIDI_LIB_PPQ (480)
    const ppqScale = MIDI_LIB_PPQ / state.ppq;
    const edits = rawEdits.map(e => {
        const out = { ...e };
        if (out.position != null) out.position = Math.round(out.position * ppqScale);
        if (out.duration != null) out.duration = Math.round(out.duration * ppqScale);
        if (out.newPosition != null) out.newPosition = Math.round(out.newPosition * ppqScale);
        return out;
    });

    try {
        const res = await fetch(`${API_BASE}/api/jobs/${jobId}/edit-notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ edits }),
        });
        const data = await res.json();
        if (!data.ok) {
            console.error('[edit-notes] failed:', JSON.stringify(data, null, 2));
            return;
        }

        // 更新短语列表（短语划分可能变了）
        if (data.phrases) {
            if (st) {
                st._synthPhrases = data.phrases;
                st._phrasesTotal = data.phrases.length;
            } else {
                state.synthPhrases = data.phrases;
                state.phrasesTotal = data.phrases.length;
            }
        }

        // 获取更新后的音高曲线
        if (st) {
            fetchTrackPitchCurve(st);
        } else {
            fetchPitchCurve(jobId);
        }

        // 精确清除受影响短语的旧缓冲（后端已确认哪些短语需要重渲染）
        if (data.affectedIndices && data.affectedIndices.length > 0) {
            const affSet = new Set(data.affectedIndices);
            if (st) {
                st.phraseBuffers = st.phraseBuffers.filter(b => !affSet.has(b.index));
            } else {
                state.phraseBuffers = state.phraseBuffers.filter(b => !affSet.has(b.index));
            }
            // 如果正在播放，立即重新调度让 animatePlayback 检测到缺失并进入黄色等待
            if (state.playing) {
                const currentPlayTime = (performance.now() - state._playStartWall) / 1000;
                stopAllSources();
                scheduleAllPhrases(currentPlayTime);
            }
            _pollGeneration++;
            pollAndReloadPhrases(jobId, _pollGeneration, data.affectedIndices, st);
        }

        // 清理前端 invalidateAffectedBuffers 多加的 _fetchingPhrases 条目
        // 后端 affectedIndices 是精确的；前端估算可能多删了相邻短语的 buffer
        // 把不在 affectedIndices 里的从 _fetchingPhrases 移除，让 renderPolling 能重新下载它们
        const backendAffKeys = new Set((data.affectedIndices || []).map(i => jobId + ':' + i));
        for (const key of _frontendInvalidatedKeys) {
            if (!backendAffKeys.has(key)) {
                state._fetchingPhrases.delete(key);
            }
        }
        _frontendInvalidatedKeys.clear();
    } catch (err) {
        console.error('[edit-notes] request error:', err);
    }
}


// ===== SECTION 23: 合成 API (弹窗准备 + 后台渲染 + 优先级) =====
async function loadVoicebanks(retries = 10, interval = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(API_BASE + '/api/voicebanks');
            const data = await res.json();
            if (data.length > 0) {
                dom.voicebankSelect.innerHTML = '';
                data.forEach(vb => {
                    const opt = document.createElement('option');
                    opt.value = vb.id;
                    opt.textContent = vb.name;
                    dom.voicebankSelect.appendChild(opt);
                });
                return;
            }
            // 后端还没初始化完，返回了空列表，等待后重试
        } catch {
            // 网络错误，等待后重试
        }
        if (i < retries - 1) {
            await new Promise(r => setTimeout(r, interval));
        }
    }
    dom.voicebankSelect.innerHTML = '<option value="">无法加载声库</option>';
}

/** 导入 MIDI 后自动触发：提交合成 → 弹窗等待准备阶段 → 关闭弹窗 → 后台渲染 */
async function autoSynthesize() {
    if (!state.midiFile) return;
    const singerId = dom.voicebankSelect.value;
    if (!singerId) {
        dom.synthError.textContent = '没有可用的声库，请先上传声库。';
        dom.synthError.style.display = 'block';
        return;
    }
    if (state.synthState === 'preparing' || state.synthState === 'rendering') return;
    dom.synthError.style.display = 'none';

    state.synthState = 'preparing';
    state.phraseBuffers = [];
    state.synthPhrases = [];
    state.phrasesTotal = 0;
    state._fetchingPhrases.clear();

    // 显示准备弹窗
    showPrepareModal();

    try {
        const fd = new FormData();
        fd.append('midi', state.midiFile);
        fd.append('singerId', singerId);
        const res = await fetch(API_BASE + '/api/synthesize', { method: 'POST', body: fd });
        const data = await res.json();
        state.synthJobId = data.jobId;

        // 轮询等待准备阶段完成（弹窗中显示进度）
        await waitForPreparePhase();

        // 准备完成 → 关闭弹窗 → 进入渲染阶段
        hidePrepareModal();
        state.synthState = 'rendering';
        state.synthDirty = false;

        // 获取后端预测的音高曲线
        fetchPitchCurve(state.synthJobId);

        // 开始后台轮询渲染进度
        startRenderPolling();
    } catch (err) {
        hidePrepareModal();
        state.synthState = 'idle';
        state.synthJobId = null;
    }
}

async function fetchPitchCurve(jobId) {
    try {
        const resp = await fetch(`${API_BASE}/api/jobs/${jobId}/pitch`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.pitchCurve && data.pitchCurve.length > 0) {
            state.pitchCurve = data.pitchCurve;
        }
        // 同步后端的 PITD 数据到前端 deviation
        if (data.pitchDeviation) {
            state.pitchDeviation = {
                xs: data.pitchDeviation.xs || [],
                ys: data.pitchDeviation.ys || [],
            };
        } else {
            state.pitchDeviation = { xs: [], ys: [] };
        }
        requestRedraw('overlay');
    } catch (err) {
        // 静默处理
    }
}

let _pitchSendTimer = null;
function sendPitchDeviationToBackend() {
    const jobId = getActiveJobId();
    if (!jobId) return;
    const { xs, ys } = getActivePitchDeviation();
    if (xs.length === 0) return;

    // 只发送本次操作修改过的 tick 范围内的数据（增量）
    const range = state._pitchDirtyRange;
    if (!range || range.min > range.max) return;
    const margin = PITD_INTERVAL * 2;
    const lo = range.min - margin;
    const hi = range.max + margin;
    const filtered = [];
    const sendScale = MIDI_LIB_PPQ / state.ppq; // 960→480: 缩放回后端 PPQ 空间
    for (let i = 0; i < xs.length; i++) {
        if (xs[i] >= lo && xs[i] <= hi) {
            filtered.push({ tick: Math.round(xs[i] * sendScale), cent: ys[i] });
        }
    }
    if (filtered.length === 0) return;

    clearTimeout(_pitchSendTimer);
    _pitchSendTimer = setTimeout(async () => {
        // 在回调时重新获取当前上下文，避免闭包捕获过时的 st
        const currentJobId = getActiveJobId();
        const st = getActiveSynthTrack();
        // jobId 已变（切轨道/关闭钢琴卷帘等），放弃发送
        if (currentJobId !== jobId) return;
        try {
            console.log('[pitch] sending', filtered.length, 'deviation points, range', lo, '-', hi);
            const resp = await fetch(`${API_BASE}/api/jobs/${jobId}/pitch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviation: filtered }),
            });
            console.log('[pitch] POST response status:', resp.status);
            if (!resp.ok) return;

            // 从后端获取受影响的短语 index
            const result = await resp.json();
            const affected = result.affectedIndices || [];
            console.log('[pitch] affected phrases:', affected);

            if (affected.length > 0) {
                // 立即删除受影响短语的旧缓冲区
                const removedSet = new Set(affected);
                if (st) {
                    st.phraseBuffers = st.phraseBuffers.filter(b => !removedSet.has(b.index));
                } else {
                    state.phraseBuffers = state.phraseBuffers.filter(b => !removedSet.has(b.index));
                }
                if (state.playing) {
                    const currentPlayTime = (performance.now() - state._playStartWall) / 1000;
                    stopAllSources();
                    scheduleAllPhrases(currentPlayTime);
                }
                _pollGeneration++;
                pollAndReloadPhrases(jobId, _pollGeneration, affected, st);
            } else {
                console.log('[pitch] no affectedIndices from server, fallback wait');
                if (st) {
                    setTimeout(() => fetchTrackPitchCurve(st), 3000);
                } else {
                    setTimeout(() => fetchPitchCurve(jobId), 3000);
                }
            }
        } catch (err) {
            // 静默处理
        }
    }, 500);
}

let _pollGeneration = 0;
/** 轮询 job 状态，等待指定短语渲染完成，然后替换音频 buffer
 *  @param {object|null} synthTrack - 单轨合成时传入轨道对象，全局合成传 null */
async function pollAndReloadPhrases(jobId, generation, affectedIndices, synthTrack) {
    const maxAttempts = 120;
    const watchSet = new Set(affectedIndices);
    const downloaded = new Set();
    console.log('[pitch] poll started, gen', generation, 'watching:', [...watchSet]);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 500));
        // 检查 jobId 是否仍有效
        const currentJobId = synthTrack ? synthTrack.synthJobId : state.synthJobId;
        if (currentJobId !== jobId || _pollGeneration !== generation) {
            console.log('[pitch] poll gen', generation, 'superseded');
            // 清理 _fetchingPhrases 防止永久阻塞
            for (const idx of watchSet) state._fetchingPhrases.delete(jobId + ':' + idx);
            return;
        }
        try {
            const res = await fetch(API_BASE + '/api/jobs/' + jobId);
            const data = await res.json();
            if (!data.phrases) continue;

            // 逐个下载已完成的 phrase，不等全部完成
            const watched = data.phrases.filter(p => watchSet.has(p.index));
            for (const p of watched) {
                if (downloaded.has(p.index)) continue;
                if (p.status === 'completed') {
                    downloaded.add(p.index);
                    if (synthTrack) {
                        synthTrack.phraseBuffers = synthTrack.phraseBuffers.filter(b => b.index !== p.index);
                        state._fetchingPhrases.delete(jobId + ':' + p.index);
                        fetchTrackPhraseAudio(synthTrack, p);
                    } else {
                        state.phraseBuffers = state.phraseBuffers.filter(b => b.index !== p.index);
                        state._fetchingPhrases.delete(jobId + ':' + p.index);
                        fetchPhraseAudio(p);
                    }
                } else if (p.status === 'failed') {
                    downloaded.add(p.index);
                    state._fetchingPhrases.delete(jobId + ':' + p.index);
                }
            }

            // 全部完成则退出
            if (downloaded.size >= watchSet.size) {
                if (synthTrack) {
                    fetchTrackPitchCurve(synthTrack);
                } else {
                    fetchPitchCurve(jobId);
                }
                console.log('[pitch] poll gen', generation, 'done, reloaded', downloaded.size, 'phrases');
                return;
            }
        } catch (err) {}
    }
    console.log('[pitch] poll gen', generation, 'timed out');
    // 超时也清理 _fetchingPhrases 防止永久阻塞
    for (const idx of watchSet) {
        if (!downloaded.has(idx)) state._fetchingPhrases.delete(jobId + ':' + idx);
    }
}

/** 弹窗中轮询准备阶段直到 phrases 列表出现 */
function waitForPreparePhase() {
    return new Promise((resolve, reject) => {
        const poll = async () => {
            if (!state.synthJobId) { reject(new Error('cancelled')); return; }
            try {
                const res = await fetch(API_BASE + '/api/jobs/' + state.synthJobId);
                const data = await res.json();

                // 更新弹窗中的进度文字
                const p = data.progress || '';
                let label = '准备中...';
                if (p.includes('Loading MIDI')) label = '加载 MIDI 文件...';
                else if (p.includes('Phonemizing')) label = '音素化处理中...';
                else if (p.startsWith('Predicting pitch')) {
                    const m = p.match(/\((\d+)\/(\d+)\)/);
                    label = m ? `音高预测中... (${m[1]}/${m[2]})` : '音高预测中...';
                }
                else if (p) label = p;
                updatePrepareModalText(label);

                if (data.status === 'failed') {
                    reject(new Error(data.error || '准备失败'));
                    return;
                }

                // 当 phrases 列表出现时，准备阶段完成
                if (data.phrases && data.phrases.length > 0) {
                    state.synthPhrases = data.phrases;
                    state.phrasesTotal = data.phrases.length;
                    resolve();
                    return;
                }

                // 如果 status 已经是 rendering 或 completed（快速完成的情况）
                if (data.status === 'rendering' || data.status === 'completed') {
                    if (data.phrases) {
                        state.synthPhrases = data.phrases;
                        state.phrasesTotal = data.phrases.length;
                    }
                    resolve();
                    return;
                }

                setTimeout(poll, 500);
            } catch (err) {
                setTimeout(poll, 1000); // 网络错误时重试
            }
        };
        poll();
    });
}

function showPrepareModal() {
    dom.prepareModal.style.display = 'flex';
    dom.prepareText.textContent = '准备中...';
}
function hidePrepareModal() {
    dom.prepareModal.style.display = 'none';
}
function updatePrepareModalText(text) {
    if (dom.prepareText) dom.prepareText.textContent = text;
}

/** 后台轮询渲染进度，发现完成的短语就下载音频 */
function startRenderPolling() {
    stopRenderPolling();
    pollRenderStatus();
    state.pollTimer = setInterval(pollRenderStatus, 500);
}
function stopRenderPolling() {
    if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
    }
}

async function pollRenderStatus() {
    if (!state.synthJobId) { stopRenderPolling(); return; }
    try {
        const res = await fetch(API_BASE + '/api/jobs/' + state.synthJobId);
        const data = await res.json();

        if (data.phrases && data.phrases.length > 0) {
            state.synthPhrases = data.phrases;
            state.phrasesTotal = data.phrases.length;

            for (const p of data.phrases) {
                if (p.status === 'completed') {
                    if (!state._fetchingPhrases.has(state.synthJobId + ':' + p.index) &&
                        !state.phraseBuffers.some(b => b.index === p.index)) {
                        fetchPhraseAudio(p);
                    }
                }
            }
        }

        if (data.status === 'completed') {
            stopRenderPolling();
            state.synthState = 'ready';
            dom.resultSection.style.display = 'block';
        }

        if (data.status === 'failed') {
            stopRenderPolling();
            state.synthState = 'idle';
            state.synthJobId = null;
        }
    } catch (err) {
        // 容忍偶尔网络错误
    }
}

async function fetchPhraseAudio(phraseInfo) {
    const fetchKey = state.synthJobId + ':' + phraseInfo.index;
    state._fetchingPhrases.add(fetchKey);
    try {
        const ctx = ensureAudioCtx();
        const url = API_BASE + '/api/jobs/' + state.synthJobId + '/phrases/' + phraseInfo.index;
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const arrayBuf = await res.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuf);

        const entry = {
            index: phraseInfo.index,
            startMs: phraseInfo.startMs,
            durationMs: phraseInfo.durationMs,
            audioBuffer,
        };
        state.phraseBuffers.push(entry);

        // 如果正在播放 → 立即调度这个新短语
        if (state.playing) {
            scheduleSinglePhrase(entry);
        }

        // 如果正在等待这个短语 → 恢复播放
        if (state.pendingPlay && state.waitingForPhrase === phraseInfo.index) {
            beginActualPlayback();
        }
    } catch (err) {
        // 短语下载失败，静默处理
    } finally {
        state._fetchingPhrases.delete(fetchKey);
    }
}

// ===== SECTION 23b: 钢琴采样回放（渐进式调度） =====

/** 渐进调度状态 */
const _pianoQueue = {
    notes: [],    // [{startSec, durSec, midi, volume}] 按 startSec 排序
    idx: 0,       // 下一个待调度的音符索引
    active: false,
};
const SCHEDULE_LOOKAHEAD = 0.3; // 提前调度 300ms

/** 构建钢琴播放队列（使用 getPlayableTracks 统一决策） */
function buildPianoPlayQueue(fromTimeSec) {
    const ticksPerSec = (state.bpm * state.ppq) / 60;
    _pianoQueue.notes = [];
    _pianoQueue.idx = 0;
    _pianoQueue.active = false;

    const playable = getPlayableTracks();
    playable.forEach(track => {
        // 人声轨道已开始合成 → 跳过钢琴（由 phrase buffer 播放）
        if (track.renderer === 'vocal' && track.synthJobId) return;
        const trackNotes = state.notes.filter(n => n.trackId === track.id);
        trackNotes.forEach(n => {
            const startSec = n.tick / ticksPerSec;
            const durSec = n.durTick / ticksPerSec;
            if (startSec + durSec <= fromTimeSec) return;
            const instId = track.instrumentId || 'piano';
            _pianoQueue.notes.push({ startSec, durSec, midi: n.midi, baseVolume: 0.7, instrumentId: instId, trackId: track.id });
        });
    });

    _pianoQueue.notes.sort((a, b) => a.startSec - b.startSec);
    // 跳过已过的音符
    while (_pianoQueue.idx < _pianoQueue.notes.length &&
           _pianoQueue.notes[_pianoQueue.idx].startSec + _pianoQueue.notes[_pianoQueue.idx].durSec <= fromTimeSec) {
        _pianoQueue.idx++;
    }
    _pianoQueue.active = true;
}

/** 每帧调用：调度即将播放的音符（按轨道乐器选择采样器） */
function tickPianoPlayback(currentTimeSec) {
    if (!_pianoQueue.active) return;
    const targetTime = currentTimeSec + SCHEDULE_LOOKAHEAD;
    const toneNow = Tone.now();

    while (_pianoQueue.idx < _pianoQueue.notes.length) {
        const n = _pianoQueue.notes[_pianoQueue.idx];
        if (n.startSec > targetTime) break;

        const sampler = getInstrumentSampler(n.instrumentId);
        if (sampler) {
            const noteName = midiNoteName(n.midi);
            const delay = Math.max(0, n.startSec - currentTimeSec);
            const dur = Math.max(0.05, n.durSec);
            // 实时读取 track 音量
            const trk = n.trackId ? state.tracks.find(t => t.id === n.trackId) : null;
            const vol = n.baseVolume * (trk ? trk.volume : 1.0);

            if (delay >= 0 && n.startSec + n.durSec > currentTimeSec) {
                if (n.startSec >= currentTimeSec) {
                    sampler.triggerAttackRelease(noteName, dur, toneNow + delay, vol);
                } else {
                    const remaining = n.durSec - (currentTimeSec - n.startSec);
                    if (remaining > 0.05) {
                        sampler.triggerAttackRelease(noteName, remaining, toneNow, vol);
                    }
                }
            }
        }
        _pianoQueue.idx++;
    }
}

/** 停止钢琴播放队列 */
function stopPianoQueue() {
    _pianoQueue.active = false;
    _pianoQueue.notes = [];
    _pianoQueue.idx = 0;
    for (const key of Object.keys(_samplers)) {
        if (_samplers[key].ready && _samplers[key].sampler) {
            try { _samplers[key].sampler.releaseAll(); } catch {}
        }
    }
}

/** 在全局播放时构建钢琴播放队列 */
function scheduleInstrumentTracks(fromTimeSec) {
    stopPianoQueue();
    buildPianoPlayQueue(fromTimeSec);
}

function startSynthesis() { autoSynthesize(); }

// ===== SECTION 24: 面板拖拽 =====
function initPanelResizers() {
    setupResizer(dom.trackResizer, dom.trackView, 60, 400);
}
function setupResizer(handle, panel, min, max) {
    let startY, startH;
    const onMove = e => {
        const newH = clamp(startH + e.clientY - startY, min, max);
        panel.style.height = newH + 'px';
        panel.style.flex = '0 0 auto';
        resizeCanvases();
        requestRedraw('all');
    };
    const onUp = () => {
        handle.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        resizeCanvases();
        requestRedraw('all');
    };
    handle.addEventListener('mousedown', e => {
        // 钢琴卷帘隐藏时不拖拽
        if (dom.pianoRoll.classList.contains('hidden')) return;
        e.preventDefault();
        startY = e.clientY;
        startH = panel.getBoundingClientRect().height;
        handle.classList.add('active');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ===== SECTION 26: 事件绑定 =====
function bindEvents() {
    dom.menuFile.addEventListener('click', () => dom.midiFileInput.click());
    dom.midiFileInput.addEventListener('change', e => { if (e.target.files[0]) loadMidiFile(e.target.files[0]); });

    dom.toolBtns.forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));

    // 右侧面板折叠/展开
    const inspector = document.querySelector('.inspector');
    const sideIcons = document.querySelectorAll('.side-icon');
    sideIcons.forEach(icon => {
        icon.addEventListener('click', () => {
            inspector.classList.toggle('collapsed');
        });
    });
    inspector.addEventListener('transitionend', () => {
        resizeCanvases();
        requestRedraw('all');
    });

    dom.btnPlay.addEventListener('click', togglePlay);
    dom.btnStop.addEventListener('click', () => { stopPlayback(); seekTo(0); });
    dom.btnPrev.addEventListener('click', () => seekTo(state.playheadTime - tickToTime(state.ppq * 4)));
    dom.btnNext.addEventListener('click', () => seekTo(state.playheadTime + tickToTime(state.ppq * 4)));

    dom.btnZoomIn.addEventListener('click', () => setZoom(state.zoom * ZOOM_STEP));
    dom.btnZoomOut.addEventListener('click', () => setZoom(state.zoom / ZOOM_STEP));

    // Canvas 区域鼠标事件
    dom.gridScrollContainer.addEventListener('mousedown', e => {
        if (e.target.closest('.ruler')) {
            const rect = dom.gridScrollContainer.getBoundingClientRect();
            const x = e.clientX - rect.left + dom.gridScrollContainer.scrollLeft;
            seekTo(tickToTime(xToTick(x)));
            return;
        }
        if (e.button === 1) { startMiddlePan(e); return; }
        if (e.button === 2) {
            if (state.tool === 'pitchpen') {
                // pitchpen 右键由工具自己处理
                const { x, y } = canvasCoords(e);
                if (y < 0) return;
                tools.pitchpen.onMouseDown(e, x, y);
                return;
            }
            e.preventDefault();
            const { x, y } = canvasCoords(e);
            const hit = hitTest(x, y);
            if (hit) { snapshot(); deleteNote(hit.note.id); }
            return;
        }
        const { x, y } = canvasCoords(e);
        if (y < 0) return;
        tools[state.tool].onMouseDown(e, x, y);
    });

    document.addEventListener('mousemove', e => {
        if (state.dragType === 'pan') {
            dom.gridScrollContainer.scrollLeft = state._panScrollLeft - (e.clientX - state.dragStartX);
            dom.gridScrollContainer.scrollTop = state._panScrollTop - (e.clientY - state.dragStartY);
            syncPianoScroll();
            return;
        }
        if (state.dragging || state.tool === 'pencil' || state.tool === 'knife') {
            const { x, y } = canvasCoords(e);
            tools[state.tool].onMouseMove(e, x, y);
        }
    });

    document.addEventListener('mouseup', e => {
        if (state.dragType === 'pan') {
            state.dragging = false;
            state.dragType = null;
            dom.gridScrollContainer.style.cursor = tools[state.tool].cursor;
            return;
        }
        if (state.dragging) {
            const { x, y } = canvasCoords(e);
            tools[state.tool].onMouseUp(e, x, y);
        }
    });

    dom.gridScrollContainer.addEventListener('contextmenu', e => e.preventDefault());

    dom.gridScrollContainer.addEventListener('wheel', e => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
            setZoom(state.zoom * factor, e.clientX);
        } else if (e.shiftKey) {
            e.preventDefault();
            dom.gridScrollContainer.scrollLeft += e.deltaY;
        }
        syncPianoScroll();
    }, { passive: false });

    // grid 滚动 → 更新 state.scrollX，同步 timeline + ruler
    dom.gridScrollContainer.addEventListener('scroll', () => {
        syncPianoScroll();
        requestRedraw('all');
        if (!_scrollSyncing) {
            mutateScrollX(dom.gridScrollContainer.scrollLeft);
        }
        if (state.playing && !state._autoScrolling) {
            state._autoFollow = false;
        }
    });

    // timeline 滚动 → 更新 state.scrollX，同步 grid + ruler
    dom.trackTimeline.addEventListener('scroll', () => {
        if (!_scrollSyncing) {
            mutateScrollX(dom.trackTimeline.scrollLeft);
            // 钢琴卷帘打开时同步钢琴键 + 重绘 canvas
            if (!dom.pianoRoll.classList.contains('hidden')) {
                syncPianoScroll();
                requestRedraw('all');
            }
        }
        if (state.playing && !state._autoScrolling) {
            state._autoFollow = false;
        }
    });

    // 轨道时间线 Ctrl+wheel → 缩放（普通滚动由原生 overflow:auto 处理）
    dom.trackTimeline.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
            setZoom(state.zoom * factor, e.clientX);
        }
    }, { passive: false });

    // 轨道标尺 Ctrl+wheel → 缩放
    if (dom.trackRuler) {
        dom.trackRuler.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
                setZoom(state.zoom * factor, e.clientX);
            }
        }, { passive: false });
    }

    // 轨道时间线单击 → 定位播放头（用 state.scrollX 计算坐标）
    dom.trackTimeline.addEventListener('click', (e) => {
        if (e.detail >= 2) return;
        const rect = dom.trackTimeline.getBoundingClientRect();
        const x = e.clientX - rect.left + state.scrollX;
        const tick = xToTick(x);
        const time = tick / state.ppq * (60 / state.bpm);
        seekTo(Math.max(0, time));
    });

    dom.inspectorLyrics.addEventListener('change', () => {
        if (state.selectedIds.size === 1) {
            const id = [...state.selectedIds][0];
            const note = state.notes.find(n => n.id === id);
            if (note) {
                snapshot();
                note.lyric = dom.inspectorLyrics.value;
                if (getActiveJobId()) pushNoteEdit({ action: 'lyric', position: note.tick, duration: note.durTick, tone: note.midi, lyric: note.lyric || 'a' });
                requestRedraw('notes');
            }
        }
    });

    dom.tensionSlider.addEventListener('input', () => { dom.tensionVal.textContent = dom.tensionSlider.value + '%'; });
    dom.breathSlider.addEventListener('input', () => { dom.breathVal.textContent = dom.breathSlider.value + '%'; });

    // 人声混响控件
    const vrToggle = document.getElementById('vocalReverbToggle');
    const vrIRSelect = document.getElementById('vocalIRSelect');
    const vrSend = document.getElementById('vocalReverbSend');
    const vrVal = document.getElementById('vocalReverbVal');
    const vrSliderGroup = document.getElementById('vocalReverbSliderGroup');
    if (vrToggle) {
        vrToggle.addEventListener('change', async () => {
            _vocalReverbEnabled = vrToggle.checked;
            vrIRSelect.style.display = _vocalReverbEnabled ? '' : 'none';
            vrSliderGroup.style.display = _vocalReverbEnabled ? '' : 'none';
            if (_vocalReverbEnabled && !_vocalCurrentIR) {
                await loadVocalIR(vrIRSelect.value);
            }
            applyVocalReverbState();
        });
        vrIRSelect.addEventListener('change', () => {
            if (_vocalReverbEnabled) loadVocalIR(vrIRSelect.value);
        });
        vrSend.addEventListener('input', () => {
            vrVal.textContent = vrSend.value + '%';
            applyVocalReverbState();
        });
    }

    dom.btnSynthesize.addEventListener('click', startSynthesis);

    dom.btnDownload.addEventListener('click', () => {
        const jobId = getActiveJobId();
        if (jobId) {
            const a = document.createElement('a');
            a.href = API_BASE + '/api/jobs/' + jobId + '/download';
            a.download = state.midiFileName.replace(/\.\w+$/, '') + '.wav';
            a.click();
        }
    });

    dom.batchLyricsClose.addEventListener('click', closeBatchLyrics);
    dom.batchLyricsCancel.addEventListener('click', closeBatchLyrics);
    dom.batchLyricsApply.addEventListener('click', applyBatchLyrics);
    dom.batchLyricsModal.addEventListener('click', e => { if (e.target === dom.batchLyricsModal) closeBatchLyrics(); });

    // MIDI 导入设置弹窗
    dom.midiImportClose.addEventListener('click', cancelMidiImport);
    dom.midiImportCancel.addEventListener('click', cancelMidiImport);
    dom.midiImportConfirm.addEventListener('click', applyMidiImport);
    dom.midiImportModal.addEventListener('click', e => { if (e.target === dom.midiImportModal) cancelMidiImport(); });

    // 键盘快捷键
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        const key = e.key.toLowerCase();
        if (key === 'z' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault(); e.shiftKey ? redo() : undo(); return;
        }
        if (key === 'y' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault(); redo(); return;
        }
        switch (key) {
            case 'v': setTool('pointer'); break;
            case 'b': setTool('pencil'); break;
            case 'e': setTool('eraser'); break;
            case 'x': setTool('knife'); break;
            case 'p': setTool('pitchpen'); break;
            case ' ':
                e.preventDefault();
                if (e.ctrlKey || e.metaKey) stopPlayback();
                else togglePlay();
                break;
            case 'delete': case 'backspace':
                e.preventDefault();
                if (state.selectedIds.size > 0) snapshot();
                deleteSelected();
                break;
            case 'a':
                if (e.ctrlKey || e.metaKey) { e.preventDefault(); selectAll(); }
                break;
            case 'l':
                if (e.ctrlKey || e.metaKey) { e.preventDefault(); openBatchLyrics(); }
                break;
        }
    });

    // 播放头拖拽（用活跃容器 + state.scrollX）
    let phDragging = false;
    dom.playhead.addEventListener('mousedown', e => { e.stopPropagation(); phDragging = true; });
    document.addEventListener('mousemove', e => {
        if (!phDragging) return;
        const ac = getActiveScrollContainer();
        const rect = ac.getBoundingClientRect();
        const x = e.clientX - rect.left + state.scrollX;
        seekTo(tickToTime(xToTick(Math.max(0, x))));
    });
    document.addEventListener('mouseup', () => { phDragging = false; });

    updatePlayheadPos();

    // 窗口大小变化时重新调整 canvas 尺寸
    window.addEventListener('resize', () => {
        resizeCanvases();
        requestRedraw('all');
    });
}

function syncPianoScroll() {
    const inner = dom.pianoKeys.querySelector('.piano-keys-inner');
    if (inner) {
        inner.style.marginTop = (-dom.gridScrollContainer.scrollTop + RULER_HEIGHT) + 'px';
    }
}

// (syncScroll 已删除，由 mutateScrollX 统一处理)
