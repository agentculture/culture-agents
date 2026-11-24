import { api } from "./api.js";
import type { RunState } from "./generated/index.js";

/** The state of a run's first event (`null` -> `queued`). */
export const initialState: RunState = api.state_machine.initial;

/** Every run state. */
export const runStates = Object.keys(api.state_machine.transitions) as RunState[];

const terminal = new Set<RunState>(api.state_machine.terminal);
const active = new Set<RunState>(api.state_machine.active);

/** Terminal states are final: no event follows and nothing changes them. */
export function isTerminal(state: RunState): boolean {
  return terminal.has(state);
}

/** Active states: `queued`, `running`, `cancelling`. */
export function isActive(state: RunState): boolean {
  return active.has(state);
}

/** States reachable from `from` in one step; `null` means "no state yet" and allows only `queued`. */
export function nextStates(from: RunState | null): readonly RunState[] {
  return from === null ? [initialState] : api.state_machine.transitions[from];
}

/** Whether `from` -> `to` is a legal transition (`from` is `null` for a run's first event). */
export function canTransition(from: RunState | null, to: RunState): boolean {
  return nextStates(from).includes(to);
}
