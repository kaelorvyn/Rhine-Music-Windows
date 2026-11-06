export type BrowseCell = { lane: number; row: number };
export type BrowseAxis = keyof BrowseCell;
export type BrowseBasis = Record<BrowseAxis, { x: number; y: number }>;

/** A single continuous coordinate; physics uses real seconds, independent of animation speed. */
export class MusicDragMotion {
  phase: 'idle' | 'drag' | 'inertia' | 'snap' = 'idle';
  position = 0;
  velocity = 0;
  private scale = 1;
  private samples: { time: number; value: number }[] = [];
  private bounds = [-Infinity, Infinity];
  private snapTime = 0;
  private snapFrom = 0;
  private snapTo = 0;
  get active() { return this.phase !== 'idle'; }
  begin(value: number, pixels: number, time: number, bounds?: readonly [number, number]) {
    this.position = value; this.velocity = 0; this.scale = Math.max(1, pixels);
    this.bounds = bounds ? [...bounds] : [-Infinity, Infinity];
    this.samples = [{ time, value }]; this.phase = 'drag';
  }
  private clamp(value: number) { return Math.max(this.bounds[0], Math.min(this.bounds[1], value)); }
  move(value: number, time: number) {
    if (this.phase !== 'drag') return;
    this.position = this.clamp(value);
    this.samples.push({ time, value: this.position });
    while (this.samples.length > 2 && this.samples[1].time < time - 100) this.samples.shift();
  }
  release(time: number, reduced = false) {
    if (this.phase !== 'drag') return;
    this.move(this.position, time);
    const samples = this.samples.filter(sample => sample.time >= time - 100), first = samples[0];
    const seconds = first ? (time - first.time) / 1000 : 0;
    const pixels = seconds > .008 ? (this.position - first.value) / seconds * this.scale : 0;
    this.velocity = Math.max(-2400, Math.min(2400, pixels)) / this.scale;
    if (reduced || Math.abs(this.velocity * this.scale) < 20) this.snap();
    else this.phase = 'inertia';
  }
  private snap() {
    this.phase = 'snap'; this.snapTime = 0; this.snapFrom = this.position;
    this.snapTo = this.clamp(Math.round(this.position)); this.velocity = 0;
  }
  cancel() { if (this.active) this.snap(); }
  reset() { this.phase = 'idle'; this.velocity = 0; this.samples = []; }
  tick(seconds: number, reduced = false) {
    if (!this.active || this.phase === 'drag') return;
    const dt = Math.max(0, seconds);
    if (this.phase === 'inertia') {
      const stop = Math.max(0, .28 * Math.log(Math.abs(this.velocity * this.scale) / 20));
      const travel = Math.min(dt, stop), decay = Math.exp(-travel / .28);
      const desired = this.position + this.velocity * .28 * (1 - decay);
      this.position = this.clamp(desired); this.velocity *= decay;
      if (reduced || travel < dt || desired !== this.position || Math.abs(this.velocity * this.scale) <= 20.00001) {
        this.snap(); if (dt > travel) this.tick(dt - travel, reduced);
      }
    } else {
      this.snapTime = reduced ? .18 : Math.min(.18, this.snapTime + dt);
      const t = this.snapTime / .18, smooth = t * t * t * (10 + t * (-15 + 6 * t));
      this.position = this.snapFrom + (this.snapTo - this.snapFrom) * smooth;
      if (t === 1) { this.position = this.snapTo; this.phase = 'idle'; }
    }
  }
}

export function browseDragAxis(dx: number, dy: number, basis: BrowseBasis): BrowseAxis | undefined {
  const length = Math.hypot(dx, dy); if (length <= 6) return;
  const score = (axis: BrowseAxis) => {
    const vector = basis[axis], size = Math.hypot(vector.x, vector.y);
    return size > 1 ? Math.abs((dx * vector.x + dy * vector.y) / (length * size)) : 0;
  };
  const row = score('row'), lane = score('lane');
  if (Math.max(row, lane) < .5 || Math.abs(row - lane) < .1) return;
  return row > lane ? 'row' : 'lane';
}

type Options = {
  enabled(): boolean;
  allowed(axis: BrowseAxis): boolean;
  basis(): BrowseBasis;
  position(): BrowseCell;
  bounds(axis: BrowseAxis): readonly [number, number] | undefined;
  begin(): void;
  move(cell: BrowseCell): void;
  finish(cell: BrowseCell): void;
  abandon(): void;
  wake(): void;
  reduced(): boolean;
};
const controls = 'button,a,input,select,textarea,label,[contenteditable],dialog,[role=dialog],[role=slider],.music-header,.music-panel-scrim,#music-detail,#music-overview,#playlist-song-bars,#album-ticks';

/** One owner for touch, pen and remote software's pressed-left-button mouse input. */
export function mountMusicDragNavigation(stage: HTMLElement, options: Options) {
  const events = new AbortController(), motion = new MusicDragMotion(), pointers = new Set<number>();
  let pointer: { id: number; x: number; y: number; cell: BrowseCell; basis: BrowseBasis } | undefined;
  let axis: BrowseAxis | undefined, cell: BrowseCell = { lane: 2, row: 12 };
  let lastFrame: number | undefined, suppressClick = false, clickTimer: ReturnType<typeof setTimeout> | undefined;
  const apply = () => { if (axis) { cell[axis] = motion.position; options.move({ ...cell }); } };
  const releaseCapture = () => { const id = pointer?.id; pointer = undefined; if (id !== undefined && stage.hasPointerCapture(id)) stage.releasePointerCapture(id); };
  const canStart = (event: PointerEvent) => {
    if (!options.enabled() || !(event.target instanceof Element) || event.target.closest(controls)) return false;
    for (let node: Element | null = event.target; node && node !== stage; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ((node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(style.overflowY)) ||
          (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(style.overflowX))) return false;
    }
    return true;
  };
  const finish = () => { if (!axis) return; apply(); axis = undefined; options.finish({ lane: Math.round(cell.lane), row: Math.round(cell.row) }); };
  const clear = (commit: boolean) => {
    releaseCapture(); pointer = undefined; pointers.clear();
    if (commit && axis) { if(!motion.active)motion.begin(cell[axis],1,0); motion.cancel(); }
    else { motion.reset(); axis = undefined; options.abandon(); }
    lastFrame = undefined;
  };
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.pointerType !== 'mouse' && !event.isPrimary) { clear(true); return; }
    if (!axis) suppressClick=false;
    pointers.add(event.pointerId);
    if (pointers.size > 1) { clear(true); return; }
    if (!canStart(event)) return;
    if (motion.active) { apply(); motion.reset(); }
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, cell: options.position(), basis: options.basis() };
    if (axis) stage.setPointerCapture(event.pointerId);
    options.wake();
  }, { capture: true, signal: events.signal });
  stage.addEventListener('pointermove', event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if(event.pointerType==='mouse' && !(event.buttons&1)){clear(true);return;}
    if (!options.enabled()) { clear(false); return; }
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    if (!axis || !motion.active) {
      const chosen = browseDragAxis(dx, dy, pointer.basis); if (!chosen || !options.allowed(chosen)) return;
      axis = chosen; cell = { ...pointer.cell };
      const vector = pointer.basis[axis];
      motion.begin(cell[axis], Math.hypot(vector.x, vector.y), event.timeStamp, options.bounds(axis));
      options.begin(); stage.setPointerCapture(event.pointerId);
      suppressClick = true; clearTimeout(clickTimer);
    }
    const vector = pointer.basis[axis], size = Math.hypot(vector.x, vector.y);
    motion.move(pointer.cell[axis] - (dx * vector.x + dy * vector.y) / (size * size), event.timeStamp);
    apply(); options.wake(); event.preventDefault(); event.stopImmediatePropagation();
  }, { capture: true, passive: false, signal: events.signal });
  stage.addEventListener('pointerup', event => {
    pointers.delete(event.pointerId);
    if (!pointer || event.pointerId !== pointer.id) return;
    if (axis) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!motion.active) motion.begin(cell[axis], Math.hypot(pointer.basis[axis].x, pointer.basis[axis].y), event.timeStamp, options.bounds(axis));
      motion.release(event.timeStamp, options.reduced()); options.wake();
      clickTimer = setTimeout(() => { suppressClick = false; }, 400);
    }
    releaseCapture(); pointer = undefined;
  }, { capture: true, signal: events.signal });
  stage.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    if(event.target instanceof Element && event.target.closest(controls))return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, { capture: true, signal: events.signal });
  stage.addEventListener('pointercancel', () => clear(true), { signal: events.signal });
  stage.addEventListener('lostpointercapture', event => { if (event.target===stage && pointer?.id === event.pointerId) clear(true); }, { signal: events.signal });
  for (const name of ['dragstart', 'selectstart', 'contextmenu']) stage.addEventListener(name, event => {
    if (axis) event.preventDefault();
  }, { signal: events.signal });
  window.addEventListener('blur', () => clear(true), { signal: events.signal });
  return {
    get active() { return motion.active || axis !== undefined; },
    tick(now: number) {
      const dt = lastFrame === undefined ? 0 : Math.max(0, Math.min(.05, (now - lastFrame) / 1000)); lastFrame = now;
      if (!axis) return;
      if (!options.enabled()) { clear(false); return; }
      motion.tick(dt, options.reduced()); apply();
      if (!motion.active && !pointer) finish();
    },
    cancel(commit = true) { if (commit && axis) { motion.cancel(); if (!motion.active) motion.begin(cell[axis], 1, 0); motion.cancel(); motion.tick(.18,true); apply(); releaseCapture(); pointers.clear(); finish(); } else clear(false); },
    dispose() { clear(false); clearTimeout(clickTimer); events.abort(); },
  };
}
