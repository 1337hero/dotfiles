#!/usr/bin/env python3
"""Reads a pi session transcript for the chat pane. It only ever opens the file for reading.

A mod can't load a transcript itself: readTextFile stops at 1 MiB and these run to 55 MB. So the pane
runs this through exec and gets back compact JSON, ready to draw, always under 1 MiB.

  pi-tail.py PATH --last N                  back from the end until it has N messages
  pi-tail.py PATH --last N --before OFFSET  the same, ending at that byte offset (history)
  pi-tail.py PATH --from OFFSET             forward to the end of the file, whole lines only
  pi-tail.py PATH --result OFFSET --tool ID the result of one tool, from the line at that offset
  pi-tail.py PATH --code OFFSET --id ROW    the whole of one code row, from the line at that offset, for Copy

Everything in a transcript is data. Nothing here acts on it. Row shapes are at the top of thread.js.

A pi transcript (version 3) is a line per entry: `session`, `model_change`, `thinking_level_change`,
`message`, `custom`. Only `message` draws: a user's parts, an assistant's step (thinking, text and tool
calls), and one line per tool result. Thinking is never drawn, and `custom` entries are other mods'
business. A step is written once, whole, when it ends, so a half-written line at the end of the file is
the only incomplete thing here.
"""
import argparse
import datetime
import json
import os
import re
import sys

CHUNK = 1 << 20
MAX_REPLY = 900_000
TEXT_LIMIT = 16_000
TARGET_LIMIT = 200
RESULT_LIMIT = 24_000

ANSI = re.compile(r"\x1b(\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\^_])")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$")
ITEM = re.compile(r"^\s{0,3}([-*+]|\d+[.)])\s")
HEADING = re.compile(r"^#{1,6}\s")
# Brackets can nest once in the words and in the address, as in ![[x]](a(1).png).
WORDS = r"((?:[^\[\]]|\[[^\[\]]*\])*)"
ADDRESS = r"(?:[^()]|\([^()]*\))*"
IMAGE = re.compile(r"!\[" + WORDS + r"\]\(" + ADDRESS + r"\)")
LINK = re.compile(r"(?<!!)\[" + WORDS + r"\]\(\s*<?(?!https?://)" + ADDRESS + r"\)", re.I)
AUTOLINK = re.compile(r"<((?!https?://)[a-z][a-z0-9+.-]*:[^<>\s]*)>", re.I)
# A reference's address can be on the line after its label.
REFERENCE = re.compile(r"^ {0,3}\[[^\]^][^\]]*\]:[ \t]*\n?[ \t]*<?(?!https?://)\S+[ \t]*$\n?", re.I | re.M)
# The only links left as links: an inline link with plain words and an http or https address, and an http or https
# autolink. Every other bracket and angle bracket in prose is escaped, so no other link or HTML can form, whatever its shape.
SAFE_ADDRESS = r"https?://[^\s()<>\[\]\"'`\\]+(?:\([^\s()<>\[\]\"'`\\]*\)[^\s()<>\[\]\"'`\\]*)*"
SAFE_LINK = re.compile(r"(?<![!\\])\[([^\[\]\n]*)\]\((" + SAFE_ADDRESS + r")\)", re.I)
SAFE_AUTOLINK = re.compile(r"(?<!\\)<https?://[^\s<>\"'`\\]+>", re.I)
# A task list's box, as in `- [ ] item`, isn't a link and keeps its brackets.
TASK = re.compile(r"^([ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](?=[ \t])", re.M)
KEPT = re.compile("\x00(\\d+)\x00")
TRAILING_SLASHES = re.compile(r"\\+$")
BACKTICKS = re.compile(r"`+")
# What a backslash can escape in CommonMark.
PUNCTUATION = set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")

# An image is never sent: a transcript holds it as base64. A row says [image] and counts them in `images`.
IMAGE_WORD = "[image]"
# pi names its tools in lower case. The thread shows them the way the agent does.
TOOL_NAMES = {
    "bash": "Bash", "read": "Read", "edit": "Edit", "write": "Write", "webfetch": "Fetch", "websearch": "Search",
    "subagent": "Agent", "task": "Task", "todo": "Todo", "grep": "Grep", "glob": "Glob", "list": "List", "patch": "Patch",
}
TARGET_KEYS = ("command", "path", "file_path", "url", "pattern", "query", "prompt", "description", "skill")


def stamp(line):
    """A line's time in ms since the epoch, or None."""
    text = line.get("timestamp")
    if not isinstance(text, str):
        return None
    try:
        return int(datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def clip(text, limit):
    """Text and whether it was cut."""
    return (text, False) if len(text) <= limit else (text[:limit], True)


def clean(text):
    return ANSI.sub("", text)


def blocks_text(content):
    """The readable text of a tool result or a message's content."""
    if isinstance(content, str):
        return content
    parts = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            parts.append(block.get("text") or "")
        elif block.get("type") == "image":
            parts.append(IMAGE_WORD)
    return "\n".join(parts)


def content_of(message):
    """A message's content, its parts, and how many images are among them."""
    content = message.get("content")
    if isinstance(content, str):
        return content, 0
    if not isinstance(content, list):
        return "", 0
    parts = [p for p in content if isinstance(p, dict)]
    return blocks_text(parts), sum(1 for p in parts if p.get("type") == "image")


def target(tool_input):
    """The line a tool row shows after its name."""
    if not isinstance(tool_input, dict):
        return ""
    value = next((tool_input[k] for k in TARGET_KEYS if isinstance(tool_input.get(k), str)), None)
    if value is None:
        value = next((v for v in tool_input.values() if isinstance(v, str)), "")
    first = clean(value).strip().split("\n", 1)[0]
    return first[:TARGET_LIMIT]


def tool_name(name):
    text = str(name or "").strip()
    return TOOL_NAMES.get(text.lower(), text or "Tool")


def split_code(text):
    """Markdown into (kind, lang, body) parts, one for each run of prose and each fenced block."""
    parts, prose, code, fence, lang = [], [], [], None, ""
    for line in text.split("\n"):
        match = FENCE.match(line)
        if fence is None:
            if match:
                if prose:
                    parts.append(("text", "", "\n".join(prose)))
                    prose = []
                fence, lang, code = match.group(1), match.group(2), []
            else:
                prose.append(line)
        elif match and match.group(1)[0] == fence[0] and len(match.group(1)) >= len(fence) and not match.group(2):
            parts.append(("code", lang, "\n".join(code)))
            fence = None
        else:
            code.append(line)
    if fence is not None:
        parts.append(("code", lang, "\n".join(code)))
    elif prose:
        parts.append(("text", "", "\n".join(prose)))
    return [p for p in parts if p[0] == "code" or p[2].strip()]


def chunks(prose):
    """Prose into paragraphs, headings and single list items. Each is drawn as its own text element, because lines only
    sit at even steps inside one paragraph, and Sweep's covers have to sit on their lines."""
    out, open_lines = [], []

    def close():
        if open_lines:
            out.append("\n".join(open_lines))
            open_lines.clear()

    for line in prose.split("\n"):
        if not line.strip():
            close()
            continue
        heading = HEADING.match(line)
        if heading or ITEM.match(line):
            close()
        open_lines.append(line)
        if heading:
            close()
    close()
    return out


def escaped(text):
    """Text with each bracket and `<` escaped, so Markdown draws it as written. One already escaped is left alone."""
    out, slashes = [], 0
    for ch in text:
        if ch in "[]<" and slashes % 2 == 0:
            out.append("\\")
        out.append(ch)
        slashes = slashes + 1 if ch == "\\" else 0
    return "".join(out)


def guarded(text):
    """Prose with only its http and https links left as links. Anything else that could be a link or HTML is escaped."""
    kept = []

    def keep(piece):
        kept.append(piece)
        return f"\x00{len(kept) - 1}\x00"

    def link(m):
        # Words ending in a lone backslash escape the `]`, so Markdown wouldn't end the link where this does.
        if TRAILING_SLASHES.search(m.group(1)) and len(TRAILING_SLASHES.search(m.group(1)).group(0)) % 2:
            return m.group(0)
        return keep(f"[{escaped(m.group(1))}]({m.group(2)})")

    text = TASK.sub(lambda m: m.group(1) + keep(f"[{m.group(2)}]"), text)
    text = SAFE_LINK.sub(link, text)
    text = SAFE_AUTOLINK.sub(lambda m: keep(m.group(0)), text)
    return KEPT.sub(lambda m: kept[int(m.group(1))], escaped(text))


def code_parts(text):
    """Text split the way CommonMark finds inline code: prose, code, prose, and so on. A run of backticks opens a span
    only if the next run of exactly as many closes it, and a backslash escape is skipped, so `\\`` is a plain backtick.
    Anything this calls code is code to Markdown too. That's what lets code go unescaped."""
    parts, start, i, n = [], 0, 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n and text[i + 1] in PUNCTUATION:
            i += 2
            continue
        if ch != "`":
            i += 1
            continue
        run = i
        while i < n and text[i] == "`":
            i += 1
        size = i - run
        close = next((m for m in BACKTICKS.finditer(text, i) if len(m.group(0)) == size), None)
        if close:
            parts += [text[start:run], text[run:close.end()]]
            start = i = close.end()
    return parts + [text[start:]]


def inert(text):
    """Prose with its images down to their words, and links down to http and https. Markdown would draw the rest, and a press
    on a link opens it. A row of the thread can't hold `on_link_click`, so the text itself is what has to be safe. The
    common shapes keep their words, and `guarded` escapes whatever is left. Inline code is left as written. `text` is one
    chunk, which is drawn as a Markdown document of its own, so this reads it as that document will."""
    parts = code_parts(text.replace("\x00", ""))
    for i in range(0, len(parts), 2):
        part = IMAGE.sub(r"\1", parts[i])
        part = LINK.sub(r"\1", part)
        parts[i] = guarded(REFERENCE.sub("", AUTOLINK.sub(r"\1", part)))
    return "".join(parts)


def text_rows(text, line_id, at, limit=TEXT_LIMIT):
    """An assistant's text as one row per chunk and per code fence, all sharing a `block`."""
    rows = []

    def add(kind, fields, body):
        clipped, cut = clip(body, limit)
        row = {"id": f"{line_id}.{len(rows)}", "kind": kind, "block": line_id, "at": at}
        row.update(fields)
        row["code" if kind == "code" else "text"] = clipped
        if cut:
            row["clipped"] = True
        rows.append(row)

    for kind, lang, body in split_code(text):
        if kind == "code":
            add("code", {"lang": lang.lower()}, body.strip("\n"))
        else:
            # Each chunk is drawn as its own Markdown document, so each is made safe on its own.
            for chunk in chunks(body):
                safe = inert(chunk)
                if safe.strip():
                    add("text", {}, safe)
    return rows


def user_row(line_id, text, at):
    text, cut = clip(clean(text), TEXT_LIMIT)
    if not text:
        return []
    row = {"id": line_id, "kind": "user", "text": text, "at": at}
    if cut:
        row["clipped"] = True
    return [row]


def with_images(text, images):
    """A message's text with each image as [image]. pi keeps an image as its own part, so they go on the end."""
    return " ".join(part for part in (text.strip(), " ".join([IMAGE_WORD] * images)) if part)


def user_message(message, offset, at):
    """What the person typed, and the images that went with it."""
    text, images = content_of(message)
    if not text.strip() and not images:
        return []
    rows = user_row(str(offset), with_images(text, images), at)
    for row in rows:
        if images:
            row["images"] = images
    return rows


def assistant_message(message, offset, at, limit=TEXT_LIMIT):
    """One step of an assistant's answer: its prose, its code, and its tool calls. Thinking is never drawn."""
    rows = []
    content = message.get("content")
    for index, block in enumerate(content if isinstance(content, list) else []):
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            rows += text_rows(block.get("text") or "", f"{offset}.{index}", at, limit)
        elif block.get("type") == "toolCall":
            rows.append({
                "id": f"{offset}.{index}",
                "kind": "tool",
                "tool": block.get("id"),
                "name": tool_name(block.get("name")),
                "target": target(block.get("arguments")),
                "at": at,
            })
    return rows


def result_row(message, offset, at):
    """A tool's output. It never becomes a row: rows.js keeps it in `thread.results` by tool id."""
    text, cut = clip(clean(blocks_text(message.get("content"))), RESULT_LIMIT)
    row = {
        "kind": "result",
        "tool": message.get("toolCallId"),
        "ok": not message.get("isError"),
        "at": at,
        "line": offset,
        "size": len(text),
    }
    if cut:
        row["clipped"] = True
    return row


def rows_of(raw, offset):
    """The rows of one transcript line. A line that can't be mapped gives none, or it would stop every read at this offset."""
    try:
        return mapped(raw, offset)
    except Exception:
        return []


def mapped(raw, offset):
    """The rows of one line. Everything that isn't a message, and anything unreadable, gives none."""
    try:
        line = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(line, dict) or line.get("type") != "message":
        return []
    message = line.get("message")
    if not isinstance(message, dict):
        return []
    role = message.get("role")
    at = stamp(line)
    if role == "user":
        return user_message(message, offset, at)
    if role == "assistant":
        return assistant_message(message, offset, at)
    if role == "toolResult":
        return [result_row(message, offset, at)]
    return []


def size_of(rows):
    return len(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace"))


def messages(rows):
    """How many messages some rows make: one for the line, however many rows it drew. A result is no message of its own."""
    return 1 if any(row["kind"] != "result" for row in rows) else 0


def read_back(f, end, want):
    """Rows from the lines before `end`, oldest first, and where they start. Stops at `want` messages or a full reply."""
    groups, count, used, start, tail, pos = [], 0, 0, end, b"", end
    flat = lambda: [row for group in reversed(groups) for row in group]
    while pos > 0:
        step = min(CHUNK, pos)
        pos -= step
        f.seek(pos)
        tail = f.read(step) + tail
        lines = tail.split(b"\n")
        # The first piece may be the end of a line that starts further back, unless this is the top of the file.
        first = lines.pop(0) if pos else None
        offset = pos + len(first) + 1 if pos else 0
        marks = []
        for raw in lines:
            marks.append((offset, raw))
            offset += len(raw) + 1
        for at, raw in reversed(marks):
            if not raw:
                continue
            rows = rows_of(raw, at)
            used += size_of(rows)
            if used > MAX_REPLY and groups:
                return flat(), start
            groups.append(rows)
            count += messages(rows)
            start = at
            if count >= want:
                return flat(), start
        tail = first or b""
    return flat(), 0


def complete_end(f, size):
    """Where the last whole line ends. A line still being written has no newline yet."""
    pos = size
    while pos > 0:
        step = min(CHUNK, pos)
        pos -= step
        f.seek(pos)
        found = f.read(step).rfind(b"\n")
        if found >= 0:
            return pos + found + 1
    return 0


def read_forward(f, offset):
    """Rows from `offset` on, whole lines only. A line still being written waits for the next call."""
    rows, used, end, partial = [], 0, offset, False
    f.seek(offset)
    while True:
        raw = f.readline()
        if not raw.endswith(b"\n"):
            break
        found = rows_of(raw.rstrip(b"\n"), end)
        grown = size_of(found)
        if used + grown > MAX_REPLY and rows:
            partial = True
            break
        rows += found
        used += grown
        end += len(raw)
    return rows, end, partial


def result_of(f, offset, tool):
    f.seek(offset)
    try:
        line = json.loads(f.readline())
        message = line["message"]
        if message.get("toolCallId") != tool:
            return {"tool": tool, "missing": True}
        text, cut = clip(clean(blocks_text(message.get("content"))), RESULT_LIMIT)
    except (ValueError, KeyError, TypeError, AttributeError):
        return {"tool": tool, "missing": True}
    return {"tool": tool, "text": text, "ok": not message.get("isError"), "clipped": cut}


def code_of(f, offset, row_id):
    """The whole of one code row, for Copy. A row is cut at TEXT_LIMIT to keep replies small, and this is only ever one
    block, so it goes up to MAX_REPLY."""
    f.seek(offset)
    try:
        line = json.loads(f.readline())
        message = line.get("message") or {}
        rows = assistant_message(message, offset, None, MAX_REPLY) if line.get("type") == "message" else []
        row = next(r for r in rows if r.get("id") == row_id and r.get("kind") == "code")
    except (ValueError, TypeError, StopIteration, AttributeError):
        return {"id": row_id, "missing": True}
    return {"id": row_id, "code": row["code"], "clipped": bool(row.get("clipped"))}


def reply(args):
    if not args.path.endswith(".jsonl"):
        return {"error": "not a transcript"}
    try:
        f = open(args.path, "rb")
    except FileNotFoundError:
        return {"missing": True, "rows": [], "start": 0, "end": 0, "size": 0, "more": False}
    with f:
        size = os.fstat(f.fileno()).st_size
        if args.result is not None:
            return result_of(f, args.result, args.tool)
        if args.code is not None:
            return code_of(f, args.code, args.id)
        if args.start is not None:
            if args.start > size:
                return {"reset": True, "rows": [], "start": 0, "end": 0, "size": size, "more": False}
            rows, end, partial = read_forward(f, args.start)
            return {"rows": rows, "start": args.start, "end": end, "size": size, "partial": partial}
        end = complete_end(f, size) if args.before is None else min(args.before, size)
        rows, start = read_back(f, end, args.last)
        return {"rows": rows, "start": start, "end": end, "size": size, "more": start > 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--last", type=int, default=60)
    parser.add_argument("--before", type=int)
    parser.add_argument("--from", dest="start", type=int)
    parser.add_argument("--result", type=int)
    parser.add_argument("--tool")
    parser.add_argument("--code", type=int)
    parser.add_argument("--id")
    text = json.dumps(reply(parser.parse_args()), ensure_ascii=False, separators=(",", ":"))
    # A transcript can hold half a surrogate pair, which can't be written as it stands.
    sys.stdout.buffer.write(text.encode("utf-8", "replace"))


if __name__ == "__main__":
    main()
