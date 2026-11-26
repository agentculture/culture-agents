# Upgrading a 2.0 core to 3.0

This is the procedure for replacing a 2.0 core (`@culture.dev/agents` 0.15.x) with a 3.0 core on
the same state directory. Rolling back from 3.0 to 2.0 after 3.0 has written run records is not
planned and not tested.

## Do active 2.0 workers have to finish first?

No. Finishing them first is the safest course and is recommended when it costs little, but it is
not required. A worker is a detached process; stopping the 2.0 core does not stop it.

## What a 3.0 core does when they have not

At startup the 3.0 core, before it answers any request:

1. Removes run directories that have no first event and leftover temporary files
   (`*.tmp-<pid>-<n>`). A directory with at least one event is kept. A directory whose worker is
   alive, or whose liveness cannot be read, is left entirely alone.
2. Reads every run directory. A directory without `store.json` was written by 2.0 and is read as
   schema 0: the same files, no version. State comes from the event log and the worker's liveness,
   exactly as for a 3.0 run, so a finished 2.0 run is listed with its true state.
3. Reattaches to each surviving worker over its own control socket. A worker that answers is
   controlled again (`live_control` true). A worker that is alive but does not answer is reported
   `unknown` and is never signalled.

An active 2.0 worker keeps running with its 2.0 code until its run ends. It keeps rewriting
`run.json` in the 2.0 shape; that is harmless, because the core derives state from the event log
and treats `run.json` as a cache. Its `driver.json` names a module path from the 2.0 install that
the worker loaded at start; do not delete that install while 2.0 workers are alive.

A 3.0 core writes `store.json` (`{"schema": 1}`) into every run directory it creates. It does not
add one to a 2.0 directory.

## A run directory the core cannot read

A directory whose record, log, `store.json` or liveness evidence cannot be read, or whose schema is
newer than the core knows, is listed as unreadable with its run id and the reason. It is never
dropped from the listing, never counted as active for a concurrency limit, and its worker is never
signalled. Resolve it by hand (inspect the directory, stop the worker yourself if it is stray).

## Procedure

1. Optional: wait for active runs to end (`agents runs list`).
2. Stop the 2.0 core. Workers keep running.
3. Install and start the 3.0 core on the same state directory.
4. List runs. Finished 2.0 runs show their true state, surviving workers show `live_control`
   true or `unknown`, and any unreadable directory is named.
