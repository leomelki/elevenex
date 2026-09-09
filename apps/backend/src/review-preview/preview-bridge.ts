import { PREVIEW_BRIDGE_CHANNEL, PREVIEW_BRIDGE_VERSION } from './review-preview.types.js';

/**
 * The script injected into every preview document.
 *
 * Shipped as a string rather than a `.js` file next to this one because
 * `nest-cli.json` has no `assets` block, so a sibling file would never reach
 * `dist/`. Same approach as `config/vscode-web-launcher.ts`.
 *
 * It runs inside a frame sandboxed without `allow-same-origin`, so it has an
 * opaque origin: it cannot read the host page, and `event.origin` on the
 * messages it sends is the literal string "null". The parent authenticates it
 * by frame identity plus the preview id instead — see the note on postMessage
 * below.
 */
export function buildPreviewBridgeScript(): string {
  return BRIDGE_SOURCE.replace(/__CHANNEL__/g, PREVIEW_BRIDGE_CHANNEL).replace(
    /__VERSION__/g,
    String(PREVIEW_BRIDGE_VERSION),
  );
}

const BRIDGE_SOURCE = String.raw`
(function () {
  'use strict';

  var CHANNEL = '__CHANNEL__';
  var VERSION = __VERSION__;

  var config = (document.currentScript && document.currentScript.dataset) || {};
  var PREVIEW_ID = config.exPreviewId || '';
  var PREFIX = config.exPrefix || '';
  var INSTRUMENTED = config.exInstrumented === '1';
  var docPath = config.exPath || null;

  /* ---------------------------------------------------------------- storage */

  /*
   * Without allow-same-origin, touching localStorage *throws* rather than
   * returning null. A great many standalone pages read it on their first line
   * and die there, so stand in an in-memory Storage before any page script
   * runs. This is the single highest-value thing the bridge does for pages
   * that were never written with a sandbox in mind.
   */
  function installStorageShim(name) {
    try {
      // Reading the property is itself what throws in an opaque origin.
      void window[name];
      return;
    } catch (err) {
      /* fall through and shim */
    }
    try {
      var data = Object.create(null);
      var shim = {
        getItem: function (key) {
          var k = String(key);
          return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
        },
        setItem: function (key, value) { data[String(key)] = String(value); },
        removeItem: function (key) { delete data[String(key)]; },
        clear: function () { data = Object.create(null); },
        key: function (index) {
          var keys = Object.keys(data);
          return index < keys.length ? keys[index] : null;
        },
      };
      Object.defineProperty(shim, 'length', {
        get: function () { return Object.keys(data).length; },
      });
      Object.defineProperty(window, name, { value: shim, configurable: true });
    } catch (err) {
      /* nothing more we can do; the page is on its own */
    }
  }

  installStorageShim('localStorage');
  installStorageShim('sessionStorage');

  /* ---------------------------------------------------------------- posting */

  /*
   * targetOrigin must be '*': our origin is opaque, so it matches no concrete
   * origin string and any other value silently drops the message. That is safe
   * here because anyone who can receive these had to know the preview id to
   * build the frame URL in the first place, and the parent additionally checks
   * that the message came from this exact frame.
   */
  function post(type, payload) {
    var message = { ex: CHANNEL, v: VERSION, previewId: PREVIEW_ID, type: type };
    if (payload) {
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) message[key] = payload[key];
      }
    }
    try {
      window.parent.postMessage(message, '*');
    } catch (err) {
      /* the parent went away */
    }
  }

  /* -------------------------------------------------------------- selection */

  function annotatedAncestor(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return el && el.closest ? el.closest('[data-ex-line]') : null;
  }

  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      var name = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var index = 1;
        var sibling = node;
        while ((sibling = sibling.previousElementSibling)) index++;
        name += ':nth-child(' + index + ')';
      }
      parts.unshift(name);
      if (name.indexOf('body') === 0) break;
      node = parent;
    }
    return parts.join(' > ');
  }

  /*
   * Offset of a text node's start within its element's own text, valid only
   * when the element has no element children (so textContent is exactly the
   * concatenation of its text nodes).
   */
  function textOffsetWithin(el, container, offset) {
    var total = 0;
    for (var i = 0; i < el.childNodes.length; i++) {
      var child = el.childNodes[i];
      if (child === container) return total + offset;
      if (child.nodeType === 3) total += child.nodeValue.length;
    }
    return -1;
  }

  /*
   * Refine an element-granular line down to the exact line inside it.
   *
   * Only attempted for the case where it is provably safe: a leaf element
   * whose rendered text is the same length as its source span, meaning there
   * are no entities and no tags in between, so offsets map one to one. Any
   * richer mapping would have to model whitespace collapsing and entity
   * expansion, which is a lot of machinery for a hint that sits next to the
   * verbatim selected text anyway.
   */
  function lineOffsetInside(el, container, offset) {
    if (!el || el.children.length) return 0;
    var so = parseInt(el.getAttribute('data-ex-so'), 10);
    var eo = parseInt(el.getAttribute('data-ex-eo'), 10);
    if (!isFinite(so) || !isFinite(eo)) return 0;
    var text = el.textContent || '';
    if (text.length !== eo - so) return 0;
    var within = textOffsetWithin(el, container, offset);
    if (within < 0) return 0;
    var newlines = 0;
    for (var i = 0; i < within && i < text.length; i++) {
      if (text.charCodeAt(i) === 10) newlines++;
    }
    return newlines;
  }

  function sourceRefForRange(range) {
    var startEl = annotatedAncestor(range.startContainer);
    var endEl = annotatedAncestor(range.endContainer);

    if (!startEl || !endEl) {
      // Script-generated markup, or an uninstrumented document. Anchor to the
      // DOM instead; the parent handles a mention with no line numbers.
      var el = startEl || endEl || annotatedAncestor(range.commonAncestorContainer);
      var fallback = el || (range.startContainer && range.startContainer.parentElement);
      if (!fallback) return null;
      var id = fallback.getAttribute ? fallback.getAttribute('data-ex-id') : null;
      return {
        kind: 'dom',
        path: docPath,
        nodePath: cssPath(fallback),
        nodeId: id ? parseInt(id, 10) : null,
        tagName: fallback.tagName ? fallback.tagName.toLowerCase() : 'unknown',
      };
    }

    var startLine = parseInt(startEl.getAttribute('data-ex-line'), 10);
    var endAttr = endEl.getAttribute('data-ex-end-line') || endEl.getAttribute('data-ex-line');
    var endLine = parseInt(endAttr, 10);
    if (!isFinite(startLine) || !isFinite(endLine)) return null;

    startLine += lineOffsetInside(startEl, range.startContainer, range.startOffset);
    if (startEl === endEl) {
      endLine = Math.max(
        startLine,
        parseInt(endEl.getAttribute('data-ex-line'), 10) +
          lineOffsetInside(endEl, range.endContainer, range.endOffset)
      );
    }

    return {
      kind: 'lines',
      path: docPath,
      startLine: startLine,
      endLine: Math.max(startLine, endLine),
    };
  }

  var selectionTimer = null;

  function reportSelection() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      post('selection-cleared');
      return;
    }
    var text = selection.toString();
    if (!text.trim()) {
      post('selection-cleared');
      return;
    }
    var range = selection.getRangeAt(0);
    var rect = range.getBoundingClientRect();
    post('selection-changed', {
      text: text,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      source: sourceRefForRange(range),
    });
  }

  function scheduleSelectionReport() {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(reportSelection, 60);
  }

  document.addEventListener('selectionchange', scheduleSelectionReport);
  document.addEventListener('mouseup', scheduleSelectionReport, true);
  document.addEventListener('keyup', scheduleSelectionReport, true);

  /* ------------------------------------------------------------- navigation */

  document.addEventListener(
    'click',
    function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      var href = anchor.getAttribute('href') || '';
      // In-page anchors keep their native scrolling behaviour.
      if (href.charAt(0) === '#') return;

      var resolved;
      try {
        resolved = new URL(anchor.href, document.baseURI);
      } catch (err) {
        return;
      }

      var absolutePrefix = new URL(PREFIX, document.baseURI).href;
      var inside = resolved.href.indexOf(absolutePrefix) === 0;
      event.preventDefault();
      post('navigate', {
        href: resolved.href,
        path: inside ? decodeURIComponent(resolved.href.slice(absolutePrefix.length).split('?')[0].split('#')[0]) : null,
        external: !inside,
      });
    },
    true
  );

  /* ------------------------------------------------------ scroll and resize */

  var scrollPending = false;
  window.addEventListener(
    'scroll',
    function () {
      if (scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(function () {
        scrollPending = false;
        post('scroll', { top: window.scrollY || document.documentElement.scrollTop || 0 });
        positionAnchors();
      });
    },
    true
  );

  function contentHeight() {
    var el = document.documentElement;
    return Math.max(el ? el.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
  }

  if (typeof ResizeObserver === 'function') {
    var resizePending = false;
    var observer = new ResizeObserver(function () {
      if (resizePending) return;
      resizePending = true;
      requestAnimationFrame(function () {
        resizePending = false;
        post('resize', { contentHeight: contentHeight() });
        positionAnchors();
      });
    });
    if (document.documentElement) observer.observe(document.documentElement);
  }

  /* ------------------------------------------------------ discussion anchors */

  var anchorLayer = null;
  var anchors = [];
  var theme = { anchor: 'rgba(99,102,241,0.22)', anchorBorder: 'rgba(99,102,241,0.75)' };

  function ensureLayer() {
    if (anchorLayer && anchorLayer.isConnected) return anchorLayer;
    if (!document.body) return null;
    anchorLayer = document.createElement('div');
    anchorLayer.setAttribute('data-ex-anchor-layer', '');
    // An overlay rather than classes on the page's own elements: injected
    // styles would have to fight the page's CSS with !important and would
    // still perturb layout. This touches nothing the page can see.
    anchorLayer.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646';
    document.body.appendChild(anchorLayer);
    return anchorLayer;
  }

  function annotatedElements() {
    return document.querySelectorAll('[data-ex-line]');
  }

  function elementsForAnchor(anchor) {
    var source = anchor.source;
    if (!source) return [];

    if (source.kind === 'dom') {
      try {
        var found = source.nodePath ? document.querySelector(source.nodePath) : null;
        return found ? [found] : [];
      } catch (err) {
        return [];
      }
    }

    var all = annotatedElements();
    var contained = [];
    var enclosing = null;
    var enclosingSpan = Infinity;

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var start = parseInt(el.getAttribute('data-ex-line'), 10);
      var endAttr = el.getAttribute('data-ex-end-line') || el.getAttribute('data-ex-line');
      var end = parseInt(endAttr, 10);
      if (!isFinite(start) || !isFinite(end)) continue;

      if (start >= source.startLine && end <= source.endLine) {
        contained.push(el);
      } else if (start <= source.startLine && end >= source.endLine) {
        if (end - start < enclosingSpan) {
          enclosingSpan = end - start;
          enclosing = el;
        }
      }
    }

    // Nothing sits inside the range (a selection within one long element), so
    // fall back to the tightest element that contains it.
    if (!contained.length) return enclosing ? [enclosing] : [];

    // Keep only the outermost of any nested run, so a paragraph and its span
    // are not both painted.
    return contained.filter(function (el) {
      for (var j = 0; j < contained.length; j++) {
        if (contained[j] !== el && contained[j].contains(el)) return false;
      }
      return true;
    });
  }

  function positionAnchors() {
    var layer = ensureLayer();
    if (!layer) return;
    layer.textContent = '';
    if (!anchors.length) return;

    var scrollX = window.scrollX || 0;
    var scrollY = window.scrollY || 0;

    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var elements = elementsForAnchor(anchor);
      for (var j = 0; j < elements.length; j++) {
        var rect = elements[j].getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        var box = document.createElement('div');
        box.style.cssText =
          'position:absolute;pointer-events:auto;cursor:pointer;border-radius:3px;' +
          'top:' + (rect.top + scrollY - 2) + 'px;' +
          'left:' + (rect.left + scrollX - 2) + 'px;' +
          'width:' + (rect.width + 4) + 'px;' +
          'height:' + (rect.height + 4) + 'px;' +
          'background:' + theme.anchor + ';' +
          'box-shadow:inset 0 0 0 1px ' + theme.anchorBorder + ';';
        box.title = anchor.title || 'Open this discussion';
        (function (chatId) {
          box.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            post('anchor-click', { chatId: chatId });
          });
        })(anchor.chatId);
        layer.appendChild(box);
      }
    }
  }

  /* ----------------------------------------------------------- parent input */

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.ex !== CHANNEL || data.v !== VERSION || data.previewId !== PREVIEW_ID) return;

    if (data.type === 'init') {
      if (data.theme) theme = data.theme;
      positionAnchors();
      return;
    }
    if (data.type === 'scroll-to') {
      window.scrollTo(0, data.top || 0);
      return;
    }
    if (data.type === 'clear-selection') {
      var selection = window.getSelection();
      if (selection) selection.removeAllRanges();
      return;
    }
    if (data.type === 'reload') {
      window.location.reload();
      return;
    }
    if (data.type === 'highlight') {
      anchors = Array.isArray(data.anchors) ? data.anchors : [];
      positionAnchors();
      return;
    }
  });

  /* ---------------------------------------------------------------- startup */

  /*
   * A blocked resource is otherwise a blank rectangle with no explanation, and
   * the most likely cause is a preview origin the backend guessed wrong. Report
   * the first violation so the parent can say so.
   */
  var reportedViolation = false;
  document.addEventListener('securitypolicyviolation', function (event) {
    if (reportedViolation) return;
    reportedViolation = true;
    post('error', {
      message: 'Blocked by the preview content policy: ' + (event.violatedDirective || 'unknown'),
    });
  });

  function announceReady() {
    post('ready', {
      path: docPath,
      instrumented: INSTRUMENTED,
      contentHeight: contentHeight(),
      title: document.title || null,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady);
  } else {
    announceReady();
  }
  window.addEventListener('load', function () {
    post('resize', { contentHeight: contentHeight() });
    positionAnchors();
  });
})();
`;
