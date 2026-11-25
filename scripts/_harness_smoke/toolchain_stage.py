"""Stage ``toolchain`` — ``steward doctor`` plus per-harness ``guild create`` dry-runs."""

from __future__ import annotations

import json
import re
import shutil
import subprocess  # nosec B404 - runs fixed, repo-local tool invocations
from pathlib import Path
from typing import Any

from _harness_smoke.common import (
    FAIL,
    GUILD_HARNESS,
    HARNESSES,
    INVOCATIONS_REL,
    PASS,
    SKIP,
    HOME_PATH,
    STEWARD_WAIVED_PORTABILITY_PATHS,
    STEWARD_WORKSPACE_ROOT_RECORDS,
    WORKSPACE_ROOT_PATH,
    WAIVED,
    Result,
)


def _tool_argv(binary: str, dist: str) -> list[str] | None:
    """Prefer an installed CLI; otherwise let uvx fetch the published dist."""
    if shutil.which(binary):
        return [binary]
    if shutil.which("uvx"):
        return ["uvx", "--from", dist, binary]
    if shutil.which("uv"):
        return ["uv", "tool", "run", "--from", dist, binary]
    return None


def _run(argv: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # nosec B603 - argv is assembled from fixed literals above
        argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False
    )


_FINDING_PATH = re.compile(r"(?:^|\s)([\w./-]+\.(?:md|yaml|yml|toml|json)):\d+")


_FINDING_LINE = re.compile(r"^\s*([\w./-]+\.(?:md|yaml|yml|toml|json)):\d+:(.*)$")


def _portability_waived(message: str) -> bool:
    """Every flagged line is a known-accepted one.

    A vendored skill is waived as a whole file. An issue-2 record is waived per
    line, and only when each home path on the line is the workspace root (or
    its CLAUDE.md) — any other home path in those records is a real finding.
    """
    lines = [m for m in map(_FINDING_LINE.match, message.splitlines()) if m]
    if not lines:
        return False
    for match in lines:
        path, content = match.group(1), match.group(2)
        if path in STEWARD_WAIVED_PORTABILITY_PATHS:
            continue
        if path not in STEWARD_WORKSPACE_ROOT_RECORDS:
            return False
        homes = [m.group(0).rstrip(".") for m in HOME_PATH.finditer(content)]
        if not homes or not all(WORKSPACE_ROOT_PATH.fullmatch(h) for h in homes):
            return False
    return True


def check_steward_doctor(repo: Path, timeout: int) -> Result:
    base = _tool_argv("steward", "steward-cli")
    if base is None:
        return Result(
            "toolchain",
            "steward-doctor",
            SKIP,
            "neither `steward` nor `uvx`/`uv` is available — `steward doctor "
            "--scope self` was NOT run",
        )
    argv = base + ["doctor", "--scope", "self", str(repo), "--json", "--no-write-reports"]
    try:
        proc = _run(argv, repo, timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return Result("toolchain", "steward-doctor", SKIP, f"could not run steward doctor: {exc}")
    if not proc.stdout.strip():
        if "PosixPath' and 'list'" in proc.stderr:
            return Result(
                "toolchain",
                "steward-doctor",
                SKIP,
                "the resolved steward predates list-valued `prompt` entries in "
                "backend-fingerprints.yaml (it reads the registry of whatever "
                "checkout it is run from, i.e. this one) and crashed — check NOT "
                "run. It needs a steward release carrying `_agents._prompt_list`; "
                "re-run once one is published.",
            )
        return Result(
            "toolchain",
            "steward-doctor",
            SKIP,
            f"steward doctor unavailable (exit {proc.returncode}): {proc.stderr.strip()[:300]}",
        )
    try:
        findings = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return Result(
            "toolchain",
            "steward-doctor",
            FAIL,
            f"steward doctor emitted unparseable JSON: {proc.stdout.strip()[:300]}",
        )

    # A nonzero exit is expected when steward reports findings, and those are
    # judged below. A nonzero exit with an *empty* findings array is a failed
    # run wearing success-shaped JSON — it must never reach the PASS branch.
    if proc.returncode != 0 and not findings:
        return Result(
            "toolchain",
            "steward-doctor",
            FAIL,
            f"steward doctor exited {proc.returncode} but reported no findings; "
            f"the run failed rather than passing: {proc.stderr.strip()[:300]}",
        )

    unexpected: list[str] = []
    waived: list[str] = []
    for finding in findings:
        check = str(finding.get("check", "?"))
        message = str(finding.get("message", ""))
        paths = set(_FINDING_PATH.findall(message))
        if check == "portability" and paths and _portability_waived(message):
            waived.append(f"{check} ({', '.join(sorted(paths))})")
        else:
            unexpected.append(f"{check}: {message.strip()[:300]}")

    if unexpected:
        return Result("toolchain", "steward-doctor", FAIL, " | ".join(unexpected))
    if waived:
        return Result(
            "toolchain",
            "steward-doctor",
            WAIVED,
            "0 unexpected findings while carrying every harness prompt file; "
            f"{len(waived)} known-accepted finding(s) waived: {'; '.join(waived)} "
            "(vendored skills, upstream's to fix; and the workspace-root path in the issue-2 records)",
        )
    return Result(
        "toolchain",
        "steward-doctor",
        PASS,
        "0 findings while carrying every harness prompt file",
    )


def _guild_result(name: str, status: str, detail: str) -> Result:
    return Result("toolchain", f"guild-create/{name}", status, detail)


def _guild_plan_verdict(payload: dict[str, Any], guild_name: str, expected: str) -> tuple[str, str]:
    """Judge a dry-run plan: it must not be applied, and must name and write the prompt file."""
    if payload.get("applied"):
        return FAIL, "guild create reported applied=true for a dry-run"
    named = payload.get("prompt_file")
    steps = " ".join(str(s) for s in (payload.get("plan") or {}).get("steps") or [])
    if named != expected:
        return FAIL, f"--harness {guild_name} named prompt_file {named!r}, expected {expected!r}"
    if expected not in steps:
        return FAIL, (
            f"--harness {guild_name} declares prompt_file {expected!r} but no "
            f"planned step writes it: {steps[:300]}"
        )
    return PASS, f"--harness {guild_name} names and writes {expected}"


def _guild_dry_run(
    repo: Path, base: list[str], guild_name: str, expected: str, timeout: int
) -> tuple[str, str]:
    argv = base + [
        "create",
        "--agent",
        "agentculture/harness-smoke-probe",
        "--desc",
        "dry-run probe for the culture-agents harness smoke check",
        "--harness",
        guild_name,
        "--json",
    ]
    try:
        proc = _run(argv, repo, timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return SKIP, f"could not run guild: {exc}"
    if proc.returncode != 0:
        # A dry-run that exits nonzero did not succeed, whatever it wrote
        # to stdout: with no payload the tool is unavailable (SKIP, never
        # a pass), and with a payload it ran and failed (FAIL). Neither
        # may reach the plan-shape checks.
        status = SKIP if not proc.stdout.strip() else FAIL
        detail = (
            f"guild create unavailable (exit {proc.returncode})"
            if status == SKIP
            else f"guild create exited {proc.returncode} for --harness {guild_name}"
        )
        return status, f"{detail}: {proc.stderr.strip()[:300]}"
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return FAIL, f"guild create --json emitted unparseable output: {proc.stdout[:300]}"
    return _guild_plan_verdict(payload, guild_name, expected)


def _check_guild_harness(
    repo: Path, base: list[str], name: str, spec: dict[str, Any], timeout: int
) -> Result:
    if name not in GUILD_HARNESS:
        return _guild_result(
            name, SKIP, f"guild create has no harness for {name!r} — NOT verified by a dry-run"
        )
    guild_name, expected = GUILD_HARNESS[name]
    resolves = [str(p) for p in spec.get("resolves") or []]
    if expected not in resolves:
        return _guild_result(
            name,
            FAIL,
            f"{expected} is not among this harness's resolves {resolves} in {INVOCATIONS_REL}",
        )
    return _guild_result(name, *_guild_dry_run(repo, base, guild_name, expected, timeout))


def check_guild_create(repo: Path, harnesses: dict[str, Any], timeout: int) -> list[Result]:
    base = _tool_argv("guild", "guild-cli")
    if base is None:
        return [
            Result(
                "toolchain",
                "guild-create",
                SKIP,
                "neither `guild` nor `uvx`/`uv` is available — the `guild "
                "create` dry-runs were NOT run",
            )
        ]
    return [_check_guild_harness(repo, base, name, harnesses[name], timeout) for name in HARNESSES]


def stage_toolchain(repo: Path, harnesses: dict[str, Any], timeout: int) -> list[Result]:
    return [check_steward_doctor(repo, timeout)] + check_guild_create(repo, harnesses, timeout)
