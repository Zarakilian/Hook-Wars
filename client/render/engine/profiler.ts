// GPU profiling (debug only): EXT_disjoint_timer_query_webgl2 around the engine's render passes.
// Queries cannot nest, so segments are sequential: begin() closes the open one. Results arrive a few
// frames later; collect() waits for them. Without the extension, frame() falls back to gl.finish()
// timing of whole frames (CPU-observed, includes driver overhead).
import type * as THREE from 'three';

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

interface Pending {
  label: string;
  q: WebGLQuery;
}

export class GpuProfiler {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  private open: Pending | null = null;
  private pending: Pending[] = [];
  private readonly free: WebGLQuery[] = [];
  readonly samples = new Map<string, number[]>();
  disjoint = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  begin(label: string): void {
    if (!this.ext) return;
    if (this.open) this.end();
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.open = { label, q };
  }

  end(): void {
    if (!this.ext || !this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.open);
    this.open = null;
  }

  /** read finished queries into `samples` (ms) */
  poll(): number {
    if (!this.ext) return 0;
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      // timings of this window are unreliable: drop them
      this.disjoint++;
      for (const p of this.pending) this.free.push(p.q);
      this.pending = [];
      return 0;
    }
    let n = 0;
    const still: Pending[] = [];
    for (const p of this.pending) {
      if (gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) {
        const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number;
        let arr = this.samples.get(p.label);
        if (!arr) this.samples.set(p.label, (arr = []));
        arr.push(ns / 1e6);
        this.free.push(p.q);
        n++;
      } else still.push(p);
    }
    this.pending = still;
    return n;
  }

  get outstanding(): number {
    return this.pending.length;
  }

  /** wait (polling) until every issued query has a result or the timeout passes */
  async collect(timeoutMs = 3000): Promise<Record<string, { n: number; median: number; mean: number; min: number }>> {
    const t0 = Date.now();
    this.poll();
    while (this.pending.length && Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 30));
      this.poll();
    }
    const out: Record<string, { n: number; median: number; mean: number; min: number }> = {};
    for (const [k, v] of this.samples) {
      const s = [...v].sort((a, b) => a - b);
      out[k] = { n: s.length, median: +s[s.length >> 1].toFixed(3), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), min: +s[0].toFixed(3) };
    }
    return out;
  }

  reset(): void {
    this.samples.clear();
    this.disjoint = 0;
  }

  dispose(): void {
    if (this.open) this.end();
    for (const p of this.pending) this.gl.deleteQuery(p.q);
    for (const q of this.free) this.gl.deleteQuery(q);
    this.pending = [];
    this.free.length = 0;
  }
}
