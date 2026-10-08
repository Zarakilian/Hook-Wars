// Debug checks over part grids: detached voxel islands (floating cubes) and triangle budgets.
import type { RGrid } from './grid.ts';
import type { FamilyBuild, PartName } from './types.ts';

/** Connected components of filled voxels (face neighbours). Returns component sizes, biggest first. */
export function islands(g: RGrid, where?: string[]): number[] {
  const { nx, ny, nz, data } = g;
  const seen = new Uint8Array(data.length);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (data[start] < 0 || seen[start]) continue;
    let n = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop() as number;
      n++;
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      const visit = (xx: number, yy: number, zz: number) => {
        if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) return;
        const j = xx + nx * (yy + ny * zz);
        if (seen[j] || data[j] < 0) return;
        seen[j] = 1;
        stack.push(j);
      };
      visit(x + 1, y, z);
      visit(x - 1, y, z);
      visit(x, y + 1, z);
      visit(x, y - 1, z);
      visit(x, y, z + 1);
      visit(x, y, z - 1);
    }
    sizes.push(n);
    if (where && n < 80) {
      const x = start % nx;
      const y = Math.floor(start / nx) % ny;
      const z = Math.floor(start / (nx * ny));
      where.push(`${n}@(${(x / g.res + g.ox).toFixed(1)},${(y / g.res + g.oy).toFixed(1)},${(z / g.res + g.oz).toFixed(1)})`);
    }
  }
  return sizes.sort((a, b) => b - a);
}

const reported = new Set<string>();

/** One line per part grid that has more than one island (each part key reported once per page). */
export function islandReport(fb: FamilyBuild, label: string): string[] {
  const out: string[] = [];
  for (const name of Object.keys(fb.parts) as PartName[]) {
    const def = fb.parts[name];
    if (!def || !def.grid || reported.has(def.key)) continue;
    reported.add(def.key);
    const where: string[] = [];
    const s = islands(def.grid(), where);
    if (s.length > 1) out.push(`${label} ${name} [${def.key}]: ${s.length} islands, small: ${s.slice(1, 8).join(',')} ${where.slice(0, 6).join(' ')}`);
  }
  return out;
}

export function resetIslandReport(): void {
  reported.clear();
}
