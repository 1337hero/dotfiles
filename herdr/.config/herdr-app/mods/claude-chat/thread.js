// Draws the conversation. Colours come from `theme()` only.
//
// The thread's model is an array of plain row objects, oldest first, straight from tail.py (see rows.js for how replies
// merge). Rows keep the order of the transcript. `id` is stable: it comes from the row's byte offset, so the same row
// read on a different page has the same id. `at` is ms since the epoch. `clipped` is set on any row cut to fit a reply.
//
//   { id, kind: "user",   text, at, images?, clipped? }        what you typed, or a command as `/go lantern`. Plain text.
//   { id, kind: "text",   block, text, at, clipped? }          one paragraph, heading or list item of an assistant's Markdown.
//   { id, kind: "code",   block, lang, code, at, clipped? }    one fenced block. `lang` is what the fence said, lower case.
//   { id, kind: "tool",   tool, name, target, at }             one tool call. `tool` is the call's id.
//   { id, kind: "sys",    text, at, clipped? }                 a quiet line: command output, "Conversation cleared".
//   { id, kind: "worked", ms, at }                             the end of a turn.
//
// `images` counts a message's images. Image data never leaves tail.py: `text` says [image] in each one's place.
//
// `block` names the transcript block a text or code row came from, so the rows of one block share it. That's the unit
// Sweep reveals. A block is split because each chunk needs its own text element: lines only sit at even steps inside
// one paragraph, and a cover has to sit on its line.
//
// tail.py also sends { kind: "result", tool, ok, at, line, size }. It never becomes a row: rows.js keeps it in
// `thread.results` by tool id, and `line` is where `tail.py --result` finds the text when a tool line opens. In the same
// way { kind: "queue", op, text } folds into `thread.queue`, which is what the composer's tray draws.
//
// The list is made of items, not rows, because a row of a virtual list can't hold a handler. `listItems` in rows.js turns
// rows into items: { key, type, row, top }, where `type` is user, text, sys, worked, tool, code-head, code-body or status.
// A tool item adds { open, status, took, line, first, last }. A user item with `sent` is text sent and not yet in the
// transcript, drawn dim. `itemView` draws one, and takes `entry`, which wraps every
// row as it's drawn. That's the place for a row's entry motion and reveal.
//
// The list needs every height up front, so a row is measured invisibly first (`measureLayer`), and joins the list once
// it's known. It sits in a box anchored to the bottom of the thread, `OVERSCAN` taller than the thread, so a panel opening
// below keeps the last message right above it with no script running. The list's first item is a spacer of that height,
// so the first message still reaches the top.
import { chatWidth } from "./width.js";
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, TextView, Scrollbar, Editor, EditorState } from "gpui-base";
import { settings } from "herdr";
import { LAYOUT, codeLines, editorLanguage, formatTook, listSizes, mix, workedLine } from "./rows.js";
import { ease } from "./motion.js";
import { syntaxColours } from "./editors.js";

export { syntaxColours };

export const LIST_ID = "thread";
export const OVERSCAN = 480;
// The spacer's place in the list, ahead of the first item.
export const SPACER = 1;
const SIDE = 24;
const BOTTOM = LAYOUT.BOTTOM;
// The spinner the mockup agreed, native so a redraw never runs for it.
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const FRAME_MS = 110;
// tail.py cuts a tool's result at 24,000 characters.
const CLIPPED_RESULT = "Clipped at 24,000 characters";

// Geist Mono's shaping here turns " --" into "--", so `node --test` draws as `node--test`, in an editor or a plain element.
// JetBrains Mono doesn't. A command drawn wrong is worse than a near match on the font.
const CODE_FONT = "JetBrains Mono";

// How many window pixels one of the app's is. Heights report in window pixels, and `.h()` and `.pt()` take the app's.
export const zoom = () => Number(settings()?.zoom) || 1;

// The layers: the ground, then a card, a well inside it, and an edge on each.
export const layers = (t) => ({ ground: t.canvas, card: t.background, well: mix(t.canvas, t.background, 0.6), edge: t.border });

// Editor state is retained, so this can't run in a render. It runs when a reply lands, and again for every editor when the
// theme's code colours change, because an editor keeps the colours it was made with.
export const codeEditor = (row, t) => EditorState.new({
  language: editorLanguage(row.lang), value: row.code, readonly: true, line_numbers: false, folding: false, soft_wrap: false,
  font_family: CODE_FONT, font_size: 12.5, syntax: syntaxColours(t),
});

const spinner = (color, size) => div().w(15).flex_none().text_center().text_size(size).text_color(color).frames(FRAMES, FRAME_MS).child(FRAMES[0]);

const userRow = (item, t, width) => h_flex().w_full().justify_end().when(Boolean(item.sent), (e) => e.opacity(0.6))
  .child(div().max_w(Math.floor(width * 0.85)).px(14).py(9).rounded(14).bg(t.solid).text_color(t.solid_foreground).text_size(14).child(item.row.text));

// The right-hand margin the mockup keeps on prose, so long lines stay readable on a wide pane.
const proseRight = (width) => Math.min(56, Math.max(0, Math.round((width - 384) * 0.175)));

const textRow = (item, t) => div().relative().w_full().overflow_hidden().text_size(14).line_height(`${LAYOUT.LINE}px`).text_color(t.foreground)
  .child(TextView.markdown(`md-${item.row.id}`, item.row.text).selectable(true));

const sysRow = (item, t) => div().w_full().pl(4).text_size(12.5).text_color(t.dim).child(item.row.text);

const workedRow = (item, t) => div().w_full().h(20).pl(4).text_size(12.5).text_color(t.dim).child(workedLine(item.row));

function toolGlyph(item, t, working) {
  if (item.status === "ok") return svg("mods/claude-chat/check.svg").size(14).flex_none().text_color(t.done);
  if (item.status === "error") return svg("mods/claude-chat/cross.svg").size(14).flex_none().text_color(t.blocked);
  return working ? spinner(t.dim, 13) : svg("mods/claude-chat/dot.svg").size(14).flex_none().text_color(t.dim);
}

// One line of the tool card. The card is drawn across its lines: only the first has a top edge, and so on.
function toolRow(item, t, opts) {
  const { card, edge, well } = layers(t);
  // A line shutting keeps its body while it springs.
  const showing = item.open || opts.closing === item.key;
  const result = showing ? opts.results[item.row.tool] : null;
  const body = !showing ? null
    : div().mt(2).ml(23).mb(4).px(11).py(8).rounded(8).bg(well).border_1().border_color(edge).text_size(12).text_color(t.muted).font_family(CODE_FONT)
      .child(result?.text || (result?.missing ? "Unreadable" : item.status === "running" ? "Running" : result ? "No output" : "…"))
      .when(Boolean(result?.clipped), (e) => e.child(div().mt(6).text_color(t.dim).child(CLIPPED_RESULT)));
  return v_flex().pl(4).pr(4).ml(4).bg(card).border_l(1).border_r(1).border_color(edge).overflow_hidden()
    .when(item.first, (e) => e.rounded_t(12).border_t(1).pt(LAYOUT.TOOL_EDGE - 1))
    .when(item.last, (e) => e.rounded_b(12).border_b(1).pb(LAYOUT.TOOL_EDGE - 1))
    .child(h_flex().w_full().h(LAYOUT.TOOL).flex_none().px(8).gap(8).items_center().rounded(8).cursor_pointer().text_size(12.5).hover((s) => s.bg(t.hover))
      .child(h_flex().size(15).flex_none().items_center().justify_center().child(toolGlyph(item, t, opts.working)))
      .child(div().flex_none().font_medium().font_family(CODE_FONT).text_color(t.foreground).child(item.row.name))
      .child(div().flex_1().min_w(0).truncate().font_family(CODE_FONT).text_color(t.dim).child(item.row.target))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(formatTook(item.took)))
      .child(svg(item.open ? "mods/files/chevron-down.svg" : "mods/files/chevron-right.svg").size(12).flex_none().text_color(t.dim)))
    .when(Boolean(body), (e) => e.child(body));
}

// A code card is two items, so its header band can take a press. The band has the top edge, the body the rest. A block cut
// to fit a reply says so. Copy reads the whole block from the transcript, and says "Copied part" if it could only copy the cut.
function codeHead(item, t, opts) {
  const { card, edge } = layers(t);
  const copied = opts.copied === item.row.id;
  const label = item.row.clipped ? `${item.row.lang || "text"} · clipped` : item.row.lang || "text";
  return h_flex().w_full().h(LAYOUT.CODE_HEAD).pl(14).pr(8).items_center().justify_between().rounded_t(10).bg(card).border_1().border_color(edge).cursor_pointer()
    .child(div().text_size(12).text_color(t.dim).child(label))
    .child(h_flex().h(24).px(6).gap(6).items_center().rounded(6).text_size(12).text_color(copied ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
      .when(!copied, (e) => e.child(svg("mods/claude-chat/copy.svg").size(13).flex_none()))
      .child(copied ? (opts.copiedPart ? "Copied part" : "Copied") : "Copy"));
}

function codeBody(item, t, opts) {
  const { well, edge } = layers(t);
  const editor = opts.editors.get(item.row.id);
  const box = v_flex().w_full().h(codeLines(item.row.code) * LAYOUT.CODE_LINE + LAYOUT.CODE_PAD).py(12).px(14).rounded_b(10).bg(well)
    .border_l(1).border_r(1).border_b(1).border_color(edge).overflow_hidden();
  return editor ? box.child(div().w_full().h_full().child(Editor.new(editor)))
    : box.child(div().w_full().whitespace_nowrap().font_family(CODE_FONT).text_size(12.5).text_color(t.foreground).child(item.row.code));
}

function statusRow(t, live) {
  return h_flex().w_full().h(LAYOUT.STATUS).pl(4).gap(8).items_center().text_size(13).text_color(t.muted)
    .child(spinner(t.accent, 14))
    .child(ease(div().id("status-text").min_w(0).truncate(), "opacity", live.opacity, live.opacity ? "fade" : "status").child(live.text))
    .child(div().flex_none().text_size(12.5).text_color(t.dim).child(live.time));
}

// An assistant's rows share one column, with the same margins whichever kind they are.
const assistant = (body, width) => v_flex().w_full().pl(4).pr(proseRight(width)).child(body);

function drawRow(item, t, width, opts) {
  switch (item.type) {
    case "user": return userRow(item, t, width);
    case "text": return assistant(textRow(item, t), width);
    case "sys": return sysRow(item, t);
    case "worked": return workedRow(item, t);
    case "tool": return assistant(toolRow(item, t, opts), width);
    case "code-head": return assistant(codeHead(item, t, opts), width);
    case "code-body": return assistant(codeBody(item, t, opts), width);
    default: return statusRow(t, opts.live);
  }
}

// A row that can't be drawn says so. One bad row mustn't blank the list, which is what a throw here does.
function rowBody(item, t, width, opts) {
  try { return drawRow(item, t, width, opts); }
  catch { return div().w_full().pl(4).text_size(12.5).text_color(t.dim).child("Unreadable row"); }
}

// The width rows are drawn in, inside the thread's centred column.
export const columnWidth = (width) => Math.max(0, Math.min(chatWidth(width), width) - SIDE * 2);

const column = (child, width) => h_flex().w_full().justify_center().child(v_flex().w_full().max_w(chatWidth(width)).flex_none().px(SIDE).child(child));

// One item at its full width: the centred column, its gap above and its body.
const itemView = (item, t, width, opts, isLast) => column(div().w_full().pt(item.top).when(isLast, (e) => e.pb(BOTTOM))
  .child(opts.entry(item, rowBody(item, t, columnWidth(width), opts))), width);

// Rows waiting for a height, drawn at the real width where nothing shows.
function measureLayer(pending, t, width, opts, onMeasure) {
  return div().absolute().left(0).right(0).top(0).h(0).overflow_hidden().opacity(0)
    .children(pending.map((item) => column(div().id(`m-${item.key}`).w_full().flex_none()
      .on_size_change((size, cx) => onMeasure(item, size.height, cx))
      .child(rowBody(item, t, columnWidth(width), opts)), width)));
}

// The thread. `items` is what has a height, and `pending` what's waiting for one. `height` is the thread's height with
// no panel open. `opts` holds what rows read: `results`, `editors`, `live`, `working`, `copied`, `copiedPart`, and the motion: `entry`
// wraps a row, `glide` moves the whole list, `sliding` lets a row reach out of its slot while a tool line moves, `tail` is
// room below the last row for that move, and `closing` names a tool line shutting.
export function threadView({ items, heights, width, height, pending, handle, landed, onDrawing, onRange, onPress, onMeasure, onWheel, opts }, t) {
  const count = items.length;
  const sizes = listSizes(items, heights, { overscan: OVERSCAN, tail: opts.tail });
  const list = () => v_virtual_list(LIST_ID, count + SPACER, sizes, (i) => (i ? items[i - SPACER].key : "spacer"), (range) => {
    const begun = Date.now();
    onDrawing();
    const out = [];
    for (let i = range.start; i < range.end; i++) {
      out.push(i ? div().w_full().h(sizes[i]).when(!opts.sliding, (e) => e.overflow_hidden()).child(itemView(items[i - SPACER], t, width, opts, i === count)) : div().id("spacer").h(OVERSCAN));
    }
    onRange(Math.max(0, range.start - SPACER), range.end - SPACER, count, Date.now() - begun);
    return out;
  }).track_scroll(handle).size_full().on_item_click(onPress);
  return v_flex().id("thread-box").relative().flex_1().min_h(0).overflow_hidden()
    .on_scroll_wheel(onWheel)
    .when(width > 0, (e) => e.child(measureLayer(pending, t, width, opts, onMeasure)))
    .when(width > 0 && count > 0, (e) => e
      .child(div().id("thread-anchor").absolute().left(0).right(0).bottom(0).h(height + OVERSCAN).when(!landed, (b) => b.opacity(0))
        .child(opts.glide(div().id("thread-glide").relative().size_full()).child(list())))
      .child(Scrollbar.vertical(LIST_ID).absolute().inset_0()));
}

// A quiet line in the middle of the pane, for a thread with nothing to show yet.
export const notice = (text, t) => v_flex().flex_1().min_h(0).items_center().justify_center().text_size(13).text_color(t.muted).child(div().child(text));
