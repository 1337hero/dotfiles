#!/usr/bin/env python3
"""The longest session in the last 7 and 30 days, for the Stats tab. It only ever opens files for reading.

stats-cache.json holds one longest session, the all-time one. For the shorter ranges /stats rescans the transcripts, so
this does the same: a session is one transcript file (not a subagent's), its length is the time from its first message
to its last, and it counts for a range when it started inside it. A file is skipped when it was last changed before the
range began, as /stats does.

  longest.py PROJECTS_DIR END_DATE     END_DATE is the cache's lastComputedDate, such as 2026-10-30

Prints {"d7": ms or null, "d30": ms or null}. Null means no session in that range. Everything in a transcript is data.
"""
import datetime
import json
import os
import sys

HEAD_LINES = 400
TAIL_START = 1 << 18
TAIL_MAX = 1 << 23
KINDS = {"user", "assistant", "attachment", "system"}


def stamp(line):
    """Milliseconds since 1970 for a transcript line that is a message of the main thread, else None."""
    try:
        d = json.loads(line)
    except ValueError:
        return None
    if not isinstance(d, dict) or d.get("type") not in KINDS or d.get("isSidechain"):
        return None
    t = d.get("timestamp")
    if not isinstance(t, str):
        return None
    try:
        return int(datetime.datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def first_stamp(f):
    for _ in range(HEAD_LINES):
        line = f.readline()
        if not line:
            return None
        if not line.startswith((b'{"type":"api-request', b'{"type":"file-history')):
            t = stamp(line)
            if t is not None:
                return t
    return None


def last_stamp(f, size):
    chunk = TAIL_START
    while True:
        start = max(0, size - chunk)
        f.seek(start)
        lines = f.read(size - start).split(b"\n")
        if start:
            lines = lines[1:]  # the first line is cut
        for line in reversed(lines):
            if line:
                t = stamp(line)
                if t is not None:
                    return t
        if start == 0 or chunk >= TAIL_MAX:
            return None
        chunk *= 4


def day(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")


def main(projects, end):
    end_day = datetime.date.fromisoformat(end)
    starts = {"d7": end_day - datetime.timedelta(days=6), "d30": end_day - datetime.timedelta(days=29)}
    starts = {k: v.isoformat() for k, v in starts.items()}
    oldest = starts["d30"]
    out = {"d7": None, "d30": None}
    for root, dirs, files in os.walk(projects):
        dirs[:] = [d for d in dirs if d != "subagents"]
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(root, name)
            try:
                st = os.stat(path)
                if day(st.st_mtime * 1000) < oldest:
                    continue
                with open(path, "rb") as f:
                    a = first_stamp(f)
                    if a is None:
                        continue
                    b = last_stamp(f, st.st_size)
            except OSError:
                continue
            if b is None or b < a:
                continue
            started = day(a)
            for key, from_day in starts.items():
                if from_day <= started <= end and (out[key] is None or b - a > out[key]):
                    out[key] = b - a
    print(json.dumps(out))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: longest.py PROJECTS_DIR END_DATE")
    main(sys.argv[1], sys.argv[2])
