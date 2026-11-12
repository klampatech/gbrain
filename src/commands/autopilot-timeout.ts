/**
 * autopilot-timeout.ts — dispatch timeout policy for the autopilot daemon.
 *
 * #2781: the full-cycle floor used to be a literal `1_800_000` that merely
 * HAPPENED to match the 'autopilot-cycle' handler anchor
 * (`HANDLER_DEFAULT_TIMEOUT_MS`, #1737) instead of being derived from it.
 * A duplicated literal can silently drift from the handler default it's
 * supposed to track — which is exactly the bug class #2781 reported: an
 * explicit `timeout_ms` stamp permanently overrides the handler default per
 * `queue.ts`'s `opts?.timeout_ms ?? defaultTimeoutMsFor`, so a stale/lower
 * literal here starves a phase the handler default was sized for.
 *
 * Concretely, on this deployment: the daemon stamped
 * `timeout_ms = max(baseInterval * 2 * 1000, 300_000)` = 600_000 ms
 * (10 min) on every `autopilot-cycle` row. A real full cycle runs 22 phases
 * and takes ~565–571 s — so cycles that ran slightly long were killed
 * mid-flight by their own deadline rather than by a fault. The
 * 'autopilot-cycle' handler anchor in handler-timeouts.ts is already sized
 * at 30 min for exactly this reason; the explicit stamp silently overrode
 * it.
 *
 * Deriving the floor from `defaultTimeoutMsFor` keeps the stamp coupled to
 * its anchor by construction. Fail fast (not `?? 0`) if the anchor ever
 * loses its entry in HANDLER_DEFAULT_TIMEOUT_MS — silently falling back to
 * "no floor" would reintroduce #2781 rather than surface the drift.
 */
import { defaultTimeoutMsFor } from '../core/minions/handler-timeouts.ts';

function requireHandlerAnchorMs(jobName: string): number {
  const ms = defaultTimeoutMsFor(jobName);
  if (ms === null) {
    throw new Error(
      `resolveAutopilotDispatchTimeoutMs: '${jobName}' has no entry in HANDLER_DEFAULT_TIMEOUT_MS ` +
      '(handler-timeouts.ts) — the full-cycle timeout floor can no longer be derived from it. ' +
      'See #2781: a missing/removed anchor here silently reintroduces the interval-derived stamp ' +
      'permanently overriding the handler default.',
    );
  }
  return ms;
}

/**
 * Full-cycle job names on THIS tree. Upstream master also dispatches
 * 'autopilot-global-maintenance' through the same floor; this tree has no
 * such handler, so it is not listed here — adding one means adding its
 * name below so the floor tracks its anchor too (and the require() call
 * then fails loudly if the handler ships without an anchor, which is the
 * #2781 bug class this module exists to prevent).
 */
const FULL_CYCLE_JOB_NAMES = ['autopilot-cycle'] as const;

const FULL_CYCLE_TIMEOUT_FLOOR_MS = Math.max(
  ...FULL_CYCLE_JOB_NAMES.map(requireHandlerAnchorMs),
);

/**
 * Resolve the wall-clock budget stamped on an autopilot dispatch.
 *
 * Light dispatches (sync/freshness, extract-atoms-drain, targeted plan
 * steps) stay interval-derived: they are short by construction and the
 * interval-derived bound is the right ceiling for them.
 *
 * Full-cycle dispatch gets a floor at the handler's own anchor, so the
 * stamp can only ever be MORE generous than the handler default — never
 * less. This is the #2781 fix.
 */
export function resolveAutopilotDispatchTimeoutMs(
  baseIntervalSeconds: number,
  fullCycle: boolean,
): number {
  const intervalDerivedTimeoutMs = Math.max(baseIntervalSeconds * 2 * 1000, 300_000);
  return fullCycle
    ? Math.max(intervalDerivedTimeoutMs, FULL_CYCLE_TIMEOUT_FLOOR_MS)
    : intervalDerivedTimeoutMs;
}

/** The derived full-cycle floor, exported for tests and diagnostics. */
export function fullCycleTimeoutFloorMs(): number {
  return FULL_CYCLE_TIMEOUT_FLOOR_MS;
}
