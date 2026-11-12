/**
 * Live coalescing probe — exercises the REAL queue.add() code path
 * against the LIVE Postgres instance via the engine abstraction.
 *
 * Verifies the load-bearing claims of the patch:
 *   1. same (name, queue, source) + maxPending:1  -> coalesces, no 2nd row
 *   2. different source                           -> does NOT coalesce
 *   3. legacy NULL-source submit                  -> does NOT coalesce onto a scoped row
 *   4. expired-lock ACTIVE row                    -> does NOT suppress a new submit
 *   5. live-lock ACTIVE row                       -> DOES suppress (running cycle not re-dispatched)
 *
 * Uses a throwaway queue name so nothing real is touched, and deletes
 * its own rows at the end.
 */
import { randomUUID } from 'node:crypto';
import { createEngine } from '../src/core/engine-factory.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';

const cfg = await loadConfig();
if (!cfg) throw new Error('no config');
const engineCfg = toEngineConfig(cfg);
const engine = await createEngine(engineCfg);
await engine.connect(engineCfg);
const q = new MinionQueue(engine);

const Q = 'probe-' + randomUUID().slice(0, 8);
const SRC_A = 'probe-src-a';
const SRC_B = 'probe-src-b';

const countRows = async () => {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM minion_jobs WHERE queue=$1`, [Q]);
  return rows[0].n;
};

const scopedCount = async (source: string | null) => {
  const sql = source === null
    ? `SELECT count(*)::int AS n FROM minion_jobs
        WHERE name='autopilot-cycle' AND queue=$1 AND status IN ('waiting','active')
          AND COALESCE(data->>'sourceId', data->>'source_id') IS NOT DISTINCT FROM NULL`
    : `SELECT count(*)::int AS n FROM minion_jobs
        WHERE name='autopilot-cycle' AND queue=$1 AND status IN ('waiting','active')
          AND COALESCE(data->>'sourceId', data->>'source_id') IS NOT DISTINCT FROM $2`;
  const rows = source === null
    ? await engine.executeRaw<{ n: number }>(sql, [Q])
    : await engine.executeRaw<{ n: number }>(sql, [Q, source]);
  return rows[0].n;
};

const show = (label: string, j: any) =>
  console.log(`    ${label} id=${j.id} coalesced=${j.coalesced ?? false}`);

console.log('probe queue:', Q);

console.log('\n[1] first submit, source=A, maxPending:1');
const j1 = await q.add('autopilot-cycle', { source_id: SRC_A },
  { queue: Q, maxPending: 1, timeout_ms: 1_800_000 } as any);
show('->', j1);

console.log('\n[2] second submit, SAME source, DIFFERENT idempotency key -> must coalesce');
const j2 = await q.add('autopilot-cycle', { source_id: SRC_A },
  { queue: Q, maxPending: 1, timeout_ms: 1_800_000, idempotency_key: `${Q}-key-2` } as any);
show('->', j2);
console.log('    rows in probe queue:', await countRows(), '-> expected 1 (no 2nd row)');
console.log('    scoped rows for A  :', await scopedCount(SRC_A), '-> expected 1');

console.log('\n[3] third submit, DIFFERENT source B -> must NOT coalesce');
const j3 = await q.add('autopilot-cycle', { source_id: SRC_B },
  { queue: Q, maxPending: 1, timeout_ms: 1_800_000, idempotency_key: `${Q}-key-3` } as any);
show('->', j3);
console.log('    rows in probe queue:', await countRows(), '-> expected 2');

console.log('\n[4] fourth submit, NULL source (legacy path) -> must NOT coalesce onto A');
const j4 = await q.add('autopilot-cycle', {},
  { queue: Q, maxPending: 1, timeout_ms: 1_800_000, idempotency_key: `${Q}-key-4` } as any);
show('->', j4);
console.log('    rows in probe queue:', await countRows(), '-> expected 3');
console.log('    scoped rows for NULL:', await scopedCount(null), '-> expected 1');

console.log('\n[5] expired-lock ACTIVE row must NOT suppress a new submit');
await engine.executeRaw(`UPDATE minion_jobs SET status='active', lock_until=now()-interval '1 minute' WHERE id=$1`, [j1.id]);
const j5 = await q.add('autopilot-cycle', { source_id: SRC_A },
  { queue: Q, maxPending: 1, timeout_ms: 1_800_000, idempotency_key: `${Q}-key-5` } as any);
show('->', j5);
console.log('    rows in probe queue:', await countRows(), '-> expected 4 (dead worker must not block)');

console.log('\n[6] live-lock ACTIVE row MUST suppress (running cycle not re-dispatched)');
await engine.executeRaw(`UPDATE minion_jobs SET status='active', lock_until=now()+interval '5 minutes' WHERE id=$1`, [j5.id]);
const before = await countRows();
const j6 = await q.add('autopilot-cycle', { source_id: SRC_A },
  { queue: Q, maxPending: 1, timeout_ms: 1_800_000, idempotency_key: `${Q}-key-6` } as any);
show('->', j6);
console.log('    rows before/after:', before, '/', await countRows(), '-> expected unchanged (coalesced onto live active row)');

console.log('\n=== cleanup ===');
await engine.executeRaw(`DELETE FROM minion_jobs WHERE queue=$1`, [Q]);
console.log('probe rows remaining:', await countRows());
await engine.disconnect();
