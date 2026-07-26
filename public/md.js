'use strict';
/**
 * FanBox Markdown 渲染层 —— 目标：常见 markdown 方言「一个都不掉」。
 *
 * 之前只有裸 marked：表格能出 HTML 但没样式、脚注/GFM 提示块/数学/mermaid/front matter
 * 全都原样掉成纯文本，相对路径的图片一律裂图。这里把这些补齐，统一给预览和实时预览用。
 *
 * 覆盖：CommonMark + GFM（表格/删除线/任务列表/自动链接）由 marked 提供；本层再加
 *   - YAML / TOML front matter → 折叠的元信息表（而不是被当成分隔线+标题的乱码）
 *   - GFM 提示块 > [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]
 *   - 脚注 [^id] / [^id]: 定义（含回跳）
 *   - ==高亮==、上标^x^、下标~x~、\<kbd\>
 *   - 数学 $..$ / $$..$$ / \(..\) / \[..\]（KaTeX，本地 vendor）
 *   - ```mermaid 图（懒加载 vendor，只有文档里真有图才拉 3MB）
 *   - 相对路径的图片/链接按 md 文件所在目录解析（图片走 /api/raw，md/文件链接可点开）
 *   - 标题锚点、外链 target=_blank
 * 输出统一过 DOMPurify：md 可能来自下载的陌生文件，而这个页面手里有文件系统 API，不能让它执行脚本。
 */
(() => {
  const hasMarked = () => !!window.marked && !window.__noMarked;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ---------- 路径工具：把 md 里的相对引用解析成绝对路径 ----------
  const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(u || ''));
  function joinPath(baseDir, rel) {
    if (!baseDir) return null;
    let p = String(rel || '').split(/[?#]/)[0];
    try { p = decodeURI(p); } catch { /* 已经是裸路径就算了 */ }
    if (!p) return null;
    if (p.startsWith('/')) return p; // md 里写的绝对路径就当文件系统绝对路径
    const segs = String(baseDir).replace(/\/+$/, '').split('/');
    for (const s of p.split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') { if (segs.length > 1) segs.pop(); continue; }
      segs.push(s);
    }
    return segs.join('/') || '/';
  }
  const rawUrl = (abs) => '/api/raw?path=' + encodeURIComponent(abs);

  // ---------- front matter ----------
  // 开头的 --- / +++ 块：marked 会把它渲成「分隔线 + setext 标题」的一坨乱码，先摘出来单独展示
  function splitFrontMatter(src) {
    const m = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1\r?\n?/.exec(src);
    if (!m) return { fm: null, body: src };
    return { fm: m[2], body: src.slice(m[0].length) };
  }
  function fmHtml(fm) {
    const rows = [];
    for (const line of fm.split(/\r?\n/)) {
      const mm = /^([A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/.exec(line);
      if (mm) rows.push(`<tr><th>${esc(mm[1])}</th><td>${esc(mm[2].replace(/^["']|["']$/g, ''))}</td></tr>`);
      else if (line.trim()) rows.push(`<tr><td colspan="2">${esc(line)}</td></tr>`);
    }
    if (!rows.length) return '';
    return `<details class="md-fm"><summary>front matter</summary><table>${rows.join('')}</table></details>`;
  }

  // ---------- 脚注 ----------
  // 先把定义行摘掉（marked 只会把它们当普通段落原样吐出来），正文里的 [^id] 交给 inline 扩展
  const FN_DEF = /^[ \t]{0,3}\[\^([^\]\s]+)\]:[ \t]*([\s\S]*?)(?=\n{2,}|\n[ \t]{0,3}\[\^|$)/gm;
  function extractFootnotes(src) {
    const defs = new Map();
    const body = src.replace(FN_DEF, (_, id, text) => {
      defs.set(id, text.replace(/\n[ \t]+/g, '\n').trim());
      return '';
    });
    return { defs, body };
  }

  // ---------- marked 扩展 ----------
  const ALERTS = {
    note: ['提示', '#3b82f6'], tip: ['技巧', '#10b981'], important: ['重点', '#8b5cf6'],
    warning: ['注意', '#f59e0b'], caution: ['当心', '#ef4444'],
  };

  function katexHtml(tex, display) {
    if (!window.katex) return `<code class="md-math-raw">${esc(display ? '$$' + tex + '$$' : '$' + tex + '$')}</code>`;
    try {
      return window.katex.renderToString(tex, { displayMode: !!display, throwOnError: false, output: 'html' });
    } catch (e) {
      return `<code class="md-math-raw" title="${esc(e && e.message)}">${esc(tex)}</code>`;
    }
  }

  function buildExtensions(ctx) {
    return [
      // GFM 提示块：> [!NOTE] …
      {
        name: 'fbAlert', level: 'block',
        start(src) { return src.indexOf('> [!'); },
        tokenizer(src) {
          // 用 [ \t]* 而不是 \s*：\s* 会跨过行尾把下一行的 "> " 之前吃掉，标题行残留的 ">" 会让正文又被当成引用
          const m = /^>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)(?:\n|$)((?:>.*(?:\n|$))*)/i.exec(src);
          if (!m) return undefined;
          const inner = (m[2] ? m[2] + '\n' : '') + m[3].replace(/^>[ \t]?/gm, '');
          return { type: 'fbAlert', raw: m[0], kind: m[1].toLowerCase(), tokens: this.lexer.blockTokens(inner.trim()) };
        },
        renderer(tok) {
          const [label] = ALERTS[tok.kind] || ['', ''];
          return `<div class="md-alert md-alert-${tok.kind}"><div class="md-alert-title">${esc(label)}</div>`
            + `<div class="md-alert-body">${this.parser.parse(tok.tokens)}</div></div>`;
        },
      },
      // 块级数学 $$…$$ / \[…\]
      {
        name: 'fbMathBlock', level: 'block',
        start(src) { const a = src.indexOf('$$'), b = src.indexOf('\\['); return a < 0 ? b : (b < 0 ? a : Math.min(a, b)); },
        tokenizer(src) {
          const m = /^\$\$\r?\n?([\s\S]+?)\r?\n?\$\$(?:\n|$)/.exec(src) || /^\\\[([\s\S]+?)\\\](?:\n|$)/.exec(src);
          if (!m) return undefined;
          return { type: 'fbMathBlock', raw: m[0], tex: m[1].trim() };
        },
        renderer(tok) { return `<div class="md-math-block">${katexHtml(tok.tex, true)}</div>`; },
      },
      // 行内数学 $…$ / \(…\)：$ 后紧跟空白、或整段是纯数字（$12 和 $20 这种价格）不算公式
      {
        name: 'fbMathInline', level: 'inline',
        start(src) { const a = src.indexOf('$'), b = src.indexOf('\\('); return a < 0 ? b : (b < 0 ? a : Math.min(a, b)); },
        tokenizer(src) {
          let m = /^\\\(([\s\S]+?)\\\)/.exec(src);
          if (!m) {
            m = /^\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\s)\$(?!\d)/.exec(src);
            if (m && /^[\d\s,.]*$/.test(m[1])) return undefined;
          }
          if (!m) return undefined;
          return { type: 'fbMathInline', raw: m[0], tex: m[1].trim() };
        },
        renderer(tok) { return katexHtml(tok.tex, false); },
      },
      // ==高亮==
      {
        name: 'fbMark', level: 'inline',
        start(src) { return src.indexOf('=='); },
        tokenizer(src) {
          const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
          if (!m) return undefined;
          return { type: 'fbMark', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
        },
        renderer(tok) { return `<mark>${this.parser.parseInline(tok.tokens)}</mark>`; },
      },
      // 上标 ^x^ / 下标 ~x~（~~删除线~~ 由 GFM 先接走，这里只吃单波浪线）
      {
        name: 'fbSup', level: 'inline',
        start(src) { return src.indexOf('^'); },
        tokenizer(src) {
          const m = /^\^(?=\S)([^\s^]+)\^/.exec(src);
          if (!m) return undefined;
          return { type: 'fbSup', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
        },
        renderer(tok) { return `<sup>${this.parser.parseInline(tok.tokens)}</sup>`; },
      },
      {
        name: 'fbSub', level: 'inline',
        start(src) { return src.indexOf('~'); },
        tokenizer(src) {
          const m = /^~(?=[^~\s])([^\s~]+)~(?!~)/.exec(src);
          if (!m) return undefined;
          return { type: 'fbSub', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
        },
        renderer(tok) { return `<sub>${this.parser.parseInline(tok.tokens)}</sub>`; },
      },
      // 脚注引用 [^id]
      {
        name: 'fbFootRef', level: 'inline',
        start(src) { return src.indexOf('[^'); },
        tokenizer(src) {
          const m = /^\[\^([^\]\s]+)\]/.exec(src);
          if (!m || !ctx.defs.has(m[1])) return undefined;
          const id = m[1];
          if (!ctx.order.includes(id)) ctx.order.push(id);
          ctx.refCount[id] = (ctx.refCount[id] || 0) + 1;
          return { type: 'fbFootRef', raw: m[0], id, n: ctx.order.indexOf(id) + 1, seq: ctx.refCount[id] };
        },
        renderer(tok) {
          const a = `fnref-${encodeURIComponent(tok.id)}-${tok.seq}`;
          return `<sup class="md-fnref" id="${a}"><a href="#fn-${encodeURIComponent(tok.id)}">[${tok.n}]</a></sup>`;
        },
      },
    ];
  }

  // 代码块：mermaid 交给后处理，其余照旧（高亮仍由 app.js 的 hljs 负责）
  function codeRenderer(code, infostring) {
    const lang = (infostring || '').trim().split(/\s+/)[0].toLowerCase();
    // 源码放在 <pre> 里而不是 data-src：DOMPurify 会把自定义 data 属性抹掉，正文文本才留得住
    if (lang === 'mermaid') return `<div class="md-mermaid"><pre>${esc(code)}</pre></div>`;
    const cls = lang ? ` class="language-${esc(lang)}"` : '';
    return `<pre><code${cls}>${esc(code)}</code></pre>`;
  }

  const slug = (s) => String(s).toLowerCase().trim()
    .replace(/[\s]+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 64) || 'h';

  /**
   * 渲染 markdown → 安全 HTML。
   * opts.baseDir：md 文件所在目录（用于解析相对图片/链接）；不传则相对引用保持原样。
   */
  function render(src, opts) {
    src = String(src || '');
    if (!hasMarked()) return `<pre>${esc(src)}</pre>`;
    const o = opts || {};
    const { fm, body: afterFm } = splitFrontMatter(src);
    const { defs, body } = extractFootnotes(afterFm);
    const ctx = { defs, order: [], refCount: {} };

    // 每次渲染用独立实例：脚注编号等状态挂在 ctx 上，不能被并发的另一次渲染串味
    const M = new window.marked.Marked({ gfm: true, breaks: false, pedantic: false });
    const seen = new Set();
    M.use({
      extensions: buildExtensions(ctx),
      renderer: {
        // 图片在渲染阶段就把相对路径解析好：留到 enhance 里再改，浏览器已经按原样发过一次请求（必 404）
        image(hrefOrTok, title, text) {
          const isTok = hrefOrTok && typeof hrefOrTok === 'object';
          const href = isTok ? hrefOrTok.href : hrefOrTok;
          const alt = isTok ? (hrefOrTok.text || '') : (text || '');
          const ttl = isTok ? hrefOrTok.title : title;
          let src = href || '';
          if (o.baseDir && !isExternal(src) && !src.startsWith('data:')) {
            const abs = joinPath(o.baseDir, src);
            if (abs) src = rawUrl(abs);
          }
          return `<img src="${esc(src)}" alt="${esc(alt)}"${ttl ? ` title="${esc(ttl)}"` : ''}>`;
        },
        code(codeOrTok, infostring) {
          // marked v12 传 token 对象，老签名传字符串，两种都兜住
          if (codeOrTok && typeof codeOrTok === 'object') return codeRenderer(codeOrTok.text, codeOrTok.lang);
          return codeRenderer(codeOrTok, infostring);
        },
        heading(textOrTok, level) {
          const isTok = textOrTok && typeof textOrTok === 'object';
          const lv = isTok ? textOrTok.depth : level;
          const html = isTok ? this.parser.parseInline(textOrTok.tokens) : textOrTok;
          let id = slug(html.replace(/<[^>]*>/g, ''));
          while (seen.has(id)) id += '-x';
          seen.add(id);
          return `<h${lv} id="${esc(id)}">${html}<a class="md-anchor" href="#${esc(id)}" aria-hidden="true">#</a></h${lv}>`;
        },
      },
    });

    let html = '';
    try { html = M.parse(body); } catch (e) { return `<pre>${esc(src)}</pre>`; }

    if (ctx.order.length) {
      const items = ctx.order.map((id) => {
        let inner = '';
        try { inner = M.parse(defs.get(id) || ''); } catch { inner = esc(defs.get(id) || ''); }
        const back = Array.from({ length: ctx.refCount[id] || 1 }, (_, i) =>
          `<a class="md-fnback" href="#fnref-${encodeURIComponent(id)}-${i + 1}">↩</a>`).join('');
        return `<li id="fn-${encodeURIComponent(id)}">${inner}${back}</li>`;
      }).join('');
      html += `<hr class="md-fn-sep"><ol class="md-footnotes">${items}</ol>`;
    }
    if (fm != null) html = fmHtml(fm) + html;

    html = window.DOMPurify
      ? window.DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'align', 'start', 'colspan', 'rowspan'] })
      : html;
    return `<div class="md-doc" ${o.baseDir ? `data-basedir="${esc(o.baseDir)}"` : ''}>${html}</div>`;
  }

  // ---------- 渲染后处理：相对路径、代码高亮、mermaid、图片 lightbox ----------
  let mermaidP = null, mermaidLib = null;
  // 认「有 render 的那个」而不是「window.mermaid 存在」：Milkdown/Crepe 加载后会把 window.mermaid
  // 占成一个空对象，只判存在会当成已加载，图就永远渲不出来。拿到真身后自己存一份，免得又被覆盖。
  const usableMermaid = (m) => (m && typeof m.render === 'function') ? m : null;
  function loadMermaid() {
    if (mermaidP) return mermaidP;
    mermaidP = new Promise((resolve) => {
      const done = (m) => { mermaidLib = usableMermaid(m) || mermaidLib; resolve(mermaidLib); };
      if (usableMermaid(window.mermaid)) { done(window.mermaid); return; }
      const s = document.createElement('script');
      s.src = '/vendor/mermaid/mermaid.min.js';
      s.onload = () => done(window.mermaid);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return mermaidP;
  }

  /**
   * 对已插入 DOM 的渲染结果做增强。
   * opts.baseDir 同上；opts.onOpenPath(path) 点了指向本地文件的链接时回调；opts.onImage(list, i) 点图时回调。
   */
  function enhance(root, opts) {
    if (!root) return;
    const o = opts || {};
    const baseDir = o.baseDir || root.querySelector('.md-doc')?.dataset.basedir || '';

    // 相对图片 → /api/raw；顺带记下绝对路径，供 lightbox 用
    const imgs = [];
    root.querySelectorAll('img').forEach((img) => {
      const raw = img.getAttribute('src') || '';
      if (raw.startsWith('/api/raw?path=')) {
        // 渲染阶段已解析成 /api/raw，这里只把绝对路径捞回来给 lightbox（缩略图/文件名/翻页都要用）
        try { img.dataset.fbPath = decodeURIComponent(raw.slice('/api/raw?path='.length).split('&')[0]); } catch { /* 非法转义就不标 */ }
      } else if (!isExternal(raw) && !raw.startsWith('data:') && !raw.startsWith('/api/') && baseDir) {
        const abs = joinPath(baseDir, raw);
        if (abs) { img.src = rawUrl(abs); img.dataset.fbPath = abs; }
      }
      img.loading = 'lazy';
      imgs.push(img);
      img.classList.add('md-img');
    });
    imgs.forEach((img, i) => {
      img.onclick = () => {
        const list = imgs.map((x) => ({ src: x.currentSrc || x.src, path: x.dataset.fbPath || '', name: x.alt || (x.dataset.fbPath || '').split('/').pop() || '图片' }));
        if (o.onImage) o.onImage(list, i);
      };
    });

    // 链接：外链新窗口；相对链接指向本地文件 → 交给宿主打开（md 之间互相跳转终于能用了）
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) return; // 锚点/脚注回跳，页面内滚动即可
      if (isExternal(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
      const abs = baseDir ? joinPath(baseDir, href) : null;
      if (!abs) return;
      a.dataset.fbPath = abs;
      a.title = abs;
      a.onclick = (ev) => { ev.preventDefault(); if (o.onOpenPath) o.onOpenPath(abs); };
    });

    // 代码高亮（mermaid 块不参与）
    if (window.hljs && !window.__noHljs) {
      root.querySelectorAll('pre code').forEach((b) => { try { window.hljs.highlightElement(b); } catch { /* 语言未知就算了 */ } });
    }

    // mermaid：文档里真有图才去拉那 3MB
    const mm = root.querySelectorAll('.md-mermaid');
    if (mm.length) {
      loadMermaid().then((mermaid) => {
        if (!mermaid) return;
        try {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: document.documentElement.dataset.theme === 'terminal' ? 'dark' : 'default' });
        } catch { /* 已初始化过 */ }
        mm.forEach((el, i) => {
          const src = el.dataset.fbDone ? null : (el.querySelector('pre')?.textContent || '').trim();
          if (!src) return;
          el.dataset.fbDone = '1';
          const id = 'mmd-' + Math.abs(hashStr(src)) + '-' + i;
          // 语法错就把 mermaid 的报错贴在原文上方——静默留一段源码，用户只会以为「又没渲染」
          const fail = (e) => {
            const msg = String((e && (e.str || e.message)) || e || '').split('\n')[0].slice(0, 160);
            if (msg && !el.querySelector('.md-mermaid-err')) {
              const d = document.createElement('div');
              d.className = 'md-mermaid-err';
              d.textContent = 'mermaid 渲染失败：' + msg;
              el.prepend(d);
            }
          };
          try {
            Promise.resolve(mermaid.render(id, src))
              .then((out) => { el.innerHTML = (out && out.svg) || out || el.innerHTML; })
              .catch(fail);
          } catch (e) { fail(e); }
        });
      });
    }
  }
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

  window.fbMd = { render, enhance, joinPath, rawUrl, isExternal };
})();
