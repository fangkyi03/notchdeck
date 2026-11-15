/**
 * UI translation. The source strings are the Chinese texts already in the code;
 * when English is active a MutationObserver rewrites matching text nodes and the
 * placeholder / title / aria-label attributes in place. Only whole strings that are
 * in the dictionary (or match one of its `{x}` templates) are touched, so user
 * content is left alone. Subtrees marked `data-notr` are skipped entirely.
 */
import { EN } from "./i18n-en";

export type Lang = "zh" | "en";
let lang: Lang = "zh";

export const systemLang = (): Lang => (/^zh/i.test(navigator.language) ? "zh" : "en");
export const resolveLang = (pref?: string): Lang => (pref === "zh" || pref === "en" ? pref : systemLang());
export const getLang = () => lang;

const exact = new Map<string, string>();
const templates: { re: RegExp; names: string[]; out: string; lit: number }[] = [];
for (const [k, v] of Object.entries(EN)) {
  if (!/\{\w*\}/.test(k)) { exact.set(k, v); continue; }
  const names: string[] = [];
  const src = k.split(/(\{\w*\})/).map((p) => {
    const m = /^\{(\w*)\}$/.exec(p);
    if (!m) return p.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    names.push(m[1] || String(names.length));
    return "(.+?)";
  }).join("");
  templates.push({ re: new RegExp(`^${src}$`, "s"), names, out: v, lit: k.replace(/\{\w*\}/g, "").length });
}
// Most specific (longest literal text) first.
templates.sort((a, b) => b.lit - a.lit);

/** Translate one string (returns it unchanged when there is no entry). */
export function tr(s: string): string {
  if (lang === "zh" || !/[　-鿿＀-￯]/.test(s)) return s;
  const core = s.trim();
  if (!core) return s;
  let out = exact.get(core);
  if (out === undefined) {
    for (const t of templates) {
      const m = t.re.exec(core);
      if (!m) continue;
      out = t.out;
      t.names.forEach((n, i) => { out = out!.replace(`{${n}}`, tr(m[i + 1])); });
      break;
    }
  }
  if (out === undefined) return s;
  const lead = s.slice(0, s.indexOf(core[0]));
  return lead + out + s.slice(lead.length + core.length);
}

/** Template helper for strings built in code, e.g. alerts: t("已暂存 {n} 个文件", { n }). */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = lang === "en" ? EN[s] ?? s : s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
  return out;
}

const ATTRS = ["placeholder", "title", "aria-label"];
const ORIG = Symbol("zh");
type Tagged = { [ORIG]?: string };

function skip(n: Node | null): boolean {
  for (let e = n instanceof Element ? n : n?.parentElement; e; e = e.parentElement) {
    if (e.hasAttribute("data-notr") || e.tagName === "TEXTAREA" || e.tagName === "SCRIPT" || e.tagName === "STYLE" || (e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

function fixText(n: Text) {
  const cur = n.nodeValue ?? "";
  const tag = n as unknown as Tagged;
  // React rewrote it → new source text; otherwise it's ours from last time.
  if (tag[ORIG] === undefined || (cur !== tr(tag[ORIG]!) && cur !== tag[ORIG])) tag[ORIG] = cur;
  const want = lang === "en" ? tr(tag[ORIG]!) : tag[ORIG]!;
  if (want !== cur) n.nodeValue = want;
}

function fixAttrs(e: Element) {
  for (const a of ATTRS) {
    const v = e.getAttribute(a);
    if (v == null) continue;
    const key = `data-zh-${a}`;
    let orig = e.getAttribute(key);
    if (orig == null || (v !== tr(orig) && v !== orig)) { orig = v; e.setAttribute(key, v); }
    const want = lang === "en" ? tr(orig) : orig;
    if (want !== v) e.setAttribute(a, want);
  }
}

function walk(root: Node) {
  if (skip(root)) return;
  if (root.nodeType === Node.TEXT_NODE) return fixText(root as Text);
  if (!(root instanceof Element)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n instanceof Element && (n.hasAttribute("data-notr") || n.tagName === "TEXTAREA") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  fixAttrs(root);
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === Node.TEXT_NODE ? fixText(n as Text) : fixAttrs(n as Element);
}

let observer: MutationObserver | null = null;
let baseTitle: string | undefined;

/** Switch language and (re)translate the whole document. Safe to call repeatedly. */
export function setLang(pref?: string) {
  const next = resolveLang(pref);
  const changed = next !== lang;
  lang = next;
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  if (!observer) {
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") { if (!skip(m.target)) fixText(m.target as Text); }
        else if (m.type === "attributes") { if (!skip(m.target)) fixAttrs(m.target as Element); }
        else m.addedNodes.forEach(walk);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    walk(document.documentElement);
  } else if (changed) walk(document.documentElement);
  baseTitle ??= document.title;
  document.title = tr(baseTitle);
}
