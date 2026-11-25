"""What a process is connected to, read from ``/proc`` (Linux only, no dependency).

"Agents exist without chat" is checked directly: the TCP sockets a core or
worker process holds are listed, and none may reach a chat server's port.
"""

from __future__ import annotations

import os
from pathlib import Path

_CHAT_MARKERS = ("culture_core server", "agentirc", "ircd")


def _tcp_table() -> dict[str, tuple[str, int, int, bool]]:
    """inode -> (remote address, remote port, local port, listening) for this network namespace."""
    table: dict[str, tuple[str, int, int, bool]] = {}
    for name in ("tcp", "tcp6"):
        try:
            lines = Path(f"/proc/net/{name}").read_text(encoding="ascii").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            f = line.split()
            local, remote, state, inode = f[1], f[2], f[3], f[9]
            if inode == "0":
                continue
            raddr, rport = remote.rsplit(":", 1)
            table[inode] = (raddr, int(rport, 16), int(local.rsplit(":", 1)[1], 16), state == "0A")
    return table


def _socket_inodes(pid: int) -> set[str]:
    inodes = set()
    try:
        fds = os.listdir(f"/proc/{pid}/fd")
    except OSError:
        return inodes
    for fd in fds:
        try:
            target = os.readlink(f"/proc/{pid}/fd/{fd}")
        except OSError:
            continue
        if target.startswith("socket:["):
            inodes.add(target[8:-1])
    return inodes


def tcp_sockets(pid: int) -> list[tuple[str, int, int, bool]]:
    """Every TCP socket *pid* holds: (remote address, remote port, local port, listening)."""
    table = _tcp_table()
    return sorted(table[i] for i in _socket_inodes(pid) if i in table)


def chat_servers() -> dict[int, str]:
    """Chat server processes visible on this host: pid -> command line."""
    found: dict[int, str] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            raw = Path(f"/proc/{entry}/cmdline").read_bytes()
        except OSError:
            continue
        cmd = raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()
        if "server" in cmd and any(m in cmd for m in _CHAT_MARKERS):
            found[int(entry)] = cmd
    return found


def chat_ports() -> set[int]:
    """Ports the visible chat servers listen on (readable for this user's own processes only)."""
    ports = {6667, 6697}
    for pid in chat_servers():
        ports.update(local for _, _, local, listening in tcp_sockets(pid) if listening)
    return ports
