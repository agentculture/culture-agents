# Store fixtures

`state-2.0/` is a state directory written by the 0.15.3 core (API 2.0) running the fake driver
to completion: one finished run, `succeeded`, no store schema version. Do not regenerate it with
3.0 code; it exists to prove 3.0 reads what 2.0 wrote. The absolute paths in it (repo, driver
module, worker pid) are from the machine that produced it and are never followed.
