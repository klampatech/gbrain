/**
 * v0.38 — static-shape regression for autopilot.ts ↔ dispatchPerSource wiring.
 *
 * autopilot.ts's `shouldFullCycle` branch was rewired in this wave to
 * call `dispatchPerSource` from autopilot-fanout.ts instead of
 * submitting one `autopilot-cycle` job per tick. Because the autopilot
 * loop is deep inside `runAutopilot()` and gated by a connected engine,
 * a full integration test would require a Postgres fixture. The fan-out
 * helper itself has 27 unit tests + 6 PGLite/Postgres parity tests; this
 * file pins the WIRING in autopilot.ts so a future refactor that
 * accidentally reverts to single-job dispatch fails this guard first.
 *
 * Same pattern as test/autopilot-supervisor-wiring.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveAutopilotDispatchTimeoutMs } from '../src/commands/autopilot-timeout.ts';
import { defaultTimeoutMsFor } from '../src/core/minions/handler-timeouts.ts';

const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

const AUTOPILOT_TIMEOUT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot-timeout.ts'),
  'utf8',
);

describe('autopilot.ts ↔ dispatchPerSource wiring', () => {
  test('imports dispatchPerSource from the fan-out helper', () => {
    expect(AUTOPILOT_SRC).toMatch(
      /(import\s+.*dispatchPerSource.*from\s+['"]\.\/autopilot-fanout\.ts['"]|await import\(['"]\.\/autopilot-fanout\.ts['"]\))/,
    );
  });

  test('imports resolveFanoutMax (so PGLite gets fanoutMax=1 per codex P1-3)', () => {
    expect(AUTOPILOT_SRC).toMatch(/resolveFanoutMax/);
  });

  test('calls dispatchPerSource within the shouldFullCycle branch', () => {
    // dispatchPerSource must appear in the same hot path as the
    // pre-fix `queue.add('autopilot-cycle', ...)` did — i.e. when
    // shouldFullCycle is true, not in the targeted-plan path.
    const dispatchIdx = AUTOPILOT_SRC.indexOf('dispatchPerSource(engine, queue');
    expect(dispatchIdx).toBeGreaterThan(-1);
    // Verify shouldFullCycle is structurally near the call (within
    // ~3000 chars of source, roughly the same if/else branch)
    const fullCycleIdx = AUTOPILOT_SRC.indexOf('shouldFullCycle');
    expect(fullCycleIdx).toBeGreaterThan(-1);
    expect(Math.abs(dispatchIdx - fullCycleIdx)).toBeLessThan(3000);
  });

  test('updates lastFullCycleAt on dispatch (so the 60-min floor is honored)', () => {
    // After the dispatchPerSource call, the lastFullCycleAt module var
    // must update so the next tick doesn't immediately re-fan-out.
    expect(AUTOPILOT_SRC).toMatch(/lastFullCycleAt\s*=\s*Date\.now\(\)/);
  });

  test('applies the 30-minute timeout floor only to full-cycle dispatch', () => {
    const baseIntervalSeconds = 60;
    const intervalDerivedTimeoutMs = Math.max(baseIntervalSeconds * 2 * 1000, 300_000);

    expect(resolveAutopilotDispatchTimeoutMs(baseIntervalSeconds, true)).toBeGreaterThanOrEqual(30 * 60_000);
    expect(resolveAutopilotDispatchTimeoutMs(baseIntervalSeconds, false)).toBe(intervalDerivedTimeoutMs);

    expect(AUTOPILOT_SRC).toContain(
      'const timeoutMs = resolveAutopilotDispatchTimeoutMs(baseInterval, false);',
    );
    expect(AUTOPILOT_SRC).toContain(
      'const fullCycleTimeoutMs = resolveAutopilotDispatchTimeoutMs(baseInterval, true);',
    );
    expect(AUTOPILOT_SRC).toMatch(
      /dispatchPerSource\(engine, queue, \{[\s\S]{0,300}timeoutMs: fullCycleTimeoutMs/,
    );
  });

  test('#2781: full-cycle floor is derived from the handler anchor, not a duplicated literal', () => {
    // #2781's root cause: autopilot stamped an explicit `timeout_ms` that
    // was only a `Math.max(interval-derived, 300_000)`-shaped literal, so it
    // silently overrode the 'autopilot-cycle' handler's own #1737 anchor
    // (`queue.ts`: an explicit stamp always wins over `defaultTimeoutMsFor`).
    // A literal that merely happens to equal the handler anchor can drift
    // from it again if the anchor is ever retuned in handler-timeouts.ts
    // without a matching edit here — reintroducing the exact #2781 bug class.
    //
    // Prove the floor is *derived* (not just numerically coincidental):
    // (a) it equals the anchor's value — a bare duplicated literal could
    // accidentally match once but drift the moment the anchor is retuned;
    // (b) a source-shape check that the job-name anchor lookup reaches
    // `defaultTimeoutMsFor`, and that no bare numeric literal sits in the
    // full-cycle branch.
    const cycleAnchorMs = defaultTimeoutMsFor('autopilot-cycle');
    if (cycleAnchorMs === null) throw new Error("expected a handler anchor for 'autopilot-cycle'");
    const expectedFloorMs = cycleAnchorMs;

    // A short interval collapses the interval-derived component to its
    // 300_000ms minimum, so the full-cycle result must equal the derived
    // floor exactly.
    expect(resolveAutopilotDispatchTimeoutMs(1, true)).toBe(expectedFloorMs);
    // A regular (non-full-cycle) dispatch — e.g. the 'sync' freshness job,
    // which has no long-job handler anchor — must NOT pick up the floor.
    expect(resolveAutopilotDispatchTimeoutMs(1, false)).toBe(300_000);

    // Guard against reintroducing a hardcoded literal floor directly in the
    // full-cycle branch instead of the derived FULL_CYCLE_TIMEOUT_FLOOR_MS.
    expect(AUTOPILOT_TIMEOUT_SRC).not.toMatch(/fullCycle\s*\?\s*Math\.max\([^)]*,\s*1_?800_?000\)/);
    // Pin the derivation END TO END in source shape: the anchor lookup must
    // participate in the floor's Math.max, and the full-cycle branch must
    // consume that derived const — otherwise the floor could be swapped back
    // to a bare literal while the wrapper, import, and job-name strings
    // survive as dead code and the assertions above still pass.
    expect(AUTOPILOT_TIMEOUT_SRC).toMatch(
      /FULL_CYCLE_TIMEOUT_FLOOR_MS\s*=\s*Math\.max\(\s*\.\.\.FULL_CYCLE_JOB_NAMES\.map\(requireHandlerAnchorMs\)/,
    );
    expect(AUTOPILOT_TIMEOUT_SRC).toMatch(
      /fullCycle\s*\?\s*Math\.max\(intervalDerivedTimeoutMs,\s*FULL_CYCLE_TIMEOUT_FLOOR_MS\)/,
    );
    // The wrapper itself must consult defaultTimeoutMsFor (fail-loud on a
    // missing anchor, never a numeric fallback).
    expect(AUTOPILOT_TIMEOUT_SRC).toMatch(/requireHandlerAnchorMs[\s\S]{0,200}defaultTimeoutMsFor\(jobName\)/);
  });

  test('#2781: a full-cycle stamp can never be SMALLER than the handler anchor', () => {
    // The live symptom this guards: the daemon stamped timeout_ms=600_000
    // on every autopilot-cycle row while a real cycle takes ~565-571s, so
    // long cycles were killed by their own deadline (140 of 142 dead jobs
    // in 36h = 'timeout exceeded'). The floor is a MAX, so no interval
    // can shrink it below the anchor.
    const anchorMs = defaultTimeoutMsFor('autopilot-cycle');
    if (anchorMs === null) throw new Error("expected a handler anchor for 'autopilot-cycle'");
    for (const interval of [1, 60, 300, 3600]) {
      expect(resolveAutopilotDispatchTimeoutMs(interval, true)).toBeGreaterThanOrEqual(anchorMs);
    }
  });

  test('coalesced submissions advance the lastFullCycleAt clock', () => {
    // Before the dispatched/coalesced split, a coalesced submission advanced
    // this clock via `dispatched`. Keep that behavior: an all-coalesced tick
    // (single-flight suppression) would otherwise retake the full-cycle
    // branch every tick and starve the targeted-plan path for the whole
    // in-flight window.
    expect(AUTOPILOT_SRC).toMatch(
      /result\.dispatched\.length > 0 \|\| result\.coalesced\.length > 0 \|\| result\.legacy_fallback/,
    );
  });

  test('does NOT regress to the single-job dispatch on the full-cycle path', () => {
    // Pre-PR: the shouldFullCycle branch did:
    //   const job = await queue.add('autopilot-cycle', { repoPath }, {
    //     idempotency_key: `autopilot-cycle:${slot}`, ...
    //   });
    // If a future refactor reintroduces this exact pattern in autopilot.ts,
    // the per-source fan-out has been silently reverted.
    //
    // Allow the legacy idempotency key shape ONLY inside dispatchPerSource's
    // fallback path (which is in autopilot-fanout.ts, not autopilot.ts).
    expect(AUTOPILOT_SRC).not.toMatch(/queue\.add\(['"]autopilot-cycle['"][\s\S]{0,400}idempotency_key:\s*`autopilot-cycle:\$\{slot\}`/);
  });
});
