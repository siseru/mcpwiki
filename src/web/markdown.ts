// GitHub-flavored Markdown rendering: marked (GFM) -> DOMPurify -> DOM.
import { marked } from 'marked';
import DOMPurify, { type Config } from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof HTMLAnchorElement) {
    const href = node.getAttribute('href') ?? '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    } else {
      node.removeAttribute('target');
    }
  }
  if (node instanceof HTMLInputElement) {
    // GFM task lists only.
    if (node.type !== 'checkbox') node.remove();
    else node.setAttribute('disabled', '');
  }
  if (node instanceof HTMLImageElement) {
    const src = node.getAttribute('src') ?? '';
    if (!/^(https:|\/(?!\/)|data:image\/(png|gif|jpeg|webp);)/i.test(src)) node.removeAttribute('src');
    node.setAttribute('loading', 'lazy');
    node.setAttribute('referrerpolicy', 'no-referrer');
  }
});

const PURIFY: Config & { RETURN_DOM_FRAGMENT: true } = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math'],
  FORBID_ATTR: ['style', 'srcset'],
  SANITIZE_NAMED_PROPS: true,
  RETURN_DOM_FRAGMENT: true,
};

export function renderMarkdown(md: string): DocumentFragment {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, PURIFY);
}
