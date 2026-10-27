"""Local, explicit SSH trust. Never scan, auto-accept or fetch a device key.

Install/rotate a public host key only after comparing its SHA256 fingerprint
through an independent operator channel. The journal contains public keys only.
"""
import argparse
import base64
import contextlib
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import tempfile
import time


def host_label(host: str, port: int) -> str:
    if not host or any(c.isspace() for c in host) or any(c in host for c in "/\\,@[]") or not 1 <= int(port) <= 65535:
        raise ValueError("invalid SSH host/port")
    return host if int(port) == 22 else f"[{host}]:{port}"


def _private_file(path: Path, *, existing=True):
    parent = path.parent.stat()
    if parent.st_mode & 0o022 or parent.st_uid not in (0, os.geteuid()):
        raise ValueError("SSH trust directory must not be writable by group/others")
    if path.is_symlink():
        raise ValueError("SSH trust file cannot be a symlink")
    if not path.exists():
        if existing:
            raise ValueError("SSH trust file is not configured")
        return
    meta = path.stat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_mode & 0o022 or meta.st_uid not in (0, os.geteuid()):
        raise ValueError("SSH trust file must be owned by root/current user and not writable by group/others")
    if meta.st_size > 1024 * 1024:
        raise ValueError("SSH trust file exceeds limit")


def ssh_parameters(host: str, port: int, known_hosts: str) -> dict:
    """Paramiko performs the actual host-key comparison BEFORE authentication."""
    from paramiko import HostKeys
    label = host_label(host, port)
    if not known_hosts or not Path(known_hosts).is_absolute():
        raise ValueError("known_hosts_file must be an explicit absolute local path")
    path = Path(known_hosts)
    _private_file(path)
    keys = HostKeys(str(path))
    if not keys.lookup(label):
        raise ValueError("SSH host key is absent from the configured trust file")
    return {"ssh_strict": True, "system_host_keys": False, "alt_host_keys": True, "alt_key_file": str(path),
            "disabled_algorithms": {"keys": ["ssh-rsa"], "pubkeys": ["ssh-rsa"],
                                    "kex": ["diffie-hellman-group1-sha1", "diffie-hellman-group14-sha1", "diffie-hellman-group-exchange-sha1"],
                                    "macs": ["hmac-md5", "hmac-md5-96", "hmac-sha1", "hmac-sha1-96"],
                                    "ciphers": ["3des-cbc", "blowfish-cbc", "aes128-cbc", "aes192-cbc", "aes256-cbc", "arcfour", "arcfour128", "arcfour256"]}}


def fingerprint(key) -> str:
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


def _audit(path: Path, record: dict):
    _private_file(path, existing=False)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def install_key(path: str, host: str, port: int, public_key: str, expected: str, reason: str, previous: str = "") -> dict:
    """Atomic local update with compare-and-swap and a fsynced attempt journal.

    An interrupted update is recoverable from known_hosts + its .audit.jsonl;
    changing a key requires the old fingerprint, never merely a new observation.
    """
    import fcntl
    from paramiko import HostKeys
    from paramiko.hostkeys import HostKeyEntry
    target = Path(path)
    if not target.is_absolute() or not 10 <= len(reason.strip()) <= 500:
        raise ValueError("absolute trust path and a 10..500 character reason are required")
    label = host_label(host, port)
    parts = public_key.strip().split()
    if len(parts) < 2 or len(public_key) > 16384:
        raise ValueError("provide an OpenSSH public key")
    entry = HostKeyEntry.from_line(f"{label} {parts[0]} {parts[1]}")
    if entry is None or entry.key is None or fingerprint(entry.key) != expected:
        raise ValueError("public key does not match the independently verified fingerprint")
    if entry.key.get_name() not in ("ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"):
        raise ValueError("unsupported host key type")
    if entry.key.get_name() == "ssh-rsa" and entry.key.get_bits() < 2048:
        raise ValueError("RSA host key must have at least 2048 bits and negotiate RSA/SHA2")
    _private_file(target, existing=False)
    lock = target.with_name(target.name + ".lock")
    _private_file(lock, existing=False)
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        _private_file(target, existing=False)
        keys = HostKeys(str(target)) if target.exists() else HostKeys()
        old = keys.lookup(label)
        old_fingerprints = [fingerprint(k) for k in old.values()] if old else []
        if old_fingerprints == [expected]:
            return {"changed": False, "fingerprint": expected}
        if old_fingerprints and (len(old_fingerprints) != 1 or previous != old_fingerprints[0]):
            raise ValueError("rotation requires the exact current fingerprint; multiple keys require explicit operator review")
        if not old_fingerprints and previous:
            raise ValueError("previous fingerprint supplied for an unknown host")
        if old:
            # Paramiko deletes a complete comma-separated entry on __delitem__.
            # Refuse this special case instead of deleting another device's pin.
            for line in target.read_text().splitlines():
                fields = line.strip().split()
                if fields and "," in fields[0]:
                    for name in fields[0].split(","):
                        matches = name == label or (name.startswith("|1|") and hmac.compare_digest(HostKeys.hash_host(label, name), name))
                        if matches:
                            raise ValueError("shared known_hosts entry requires explicit separation before rotation")
        # Remove only this host; never discard unrelated devices or accept both keys.
        if old:
            del keys[label]
        keys.add(label, entry.key.get_name(), entry.key)
        event = {"id": os.urandom(16).hex(), "at": time.time(), "uid": os.geteuid(), "host": label, "reason": reason.strip(),
                 "previous": old_fingerprints, "fingerprint": expected, "public_key": f"{parts[0]} {parts[1]}"}
        audit = target.with_name(target.name + ".audit.jsonl")
        _audit(audit, {**event, "state": "intent"})
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".known_hosts-", dir=target.parent, delete=False) as stream:
                temporary = stream.name
            keys.save(temporary)
            os.chmod(temporary, 0o600)
            with open(temporary, "rb") as stream:
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            temporary = None
            directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            _audit(audit, {**event, "state": "committed"})
        finally:
            if temporary:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temporary)
        return {"changed": True, "fingerprint": expected, "audit_id": event["id"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--known-hosts", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--public-key", required=True, help="OpenSSH PUBLIC key text, never a private key")
    parser.add_argument("--fingerprint", required=True)
    parser.add_argument("--previous", default="")
    parser.add_argument("--reason", required=True)
    args = parser.parse_args()
    print(json.dumps(install_key(args.known_hosts, args.host, args.port, args.public_key, args.fingerprint, args.reason, args.previous)))


if __name__ == "__main__":
    main()
