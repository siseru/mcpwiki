// Extension host (docs/extensions.md). Extensions are separately deployed bundles served from this origin under
// /ext/<id>/; the browser runs one only if its Subresource Integrity hash matches the one in config.json, which
// comes from this wiki's own (reviewed) deployment. A bundle calls globalThis.mcpwikiHost.register(...) once.
// An extension that fails to load, targets another contract version or throws never stops the wiki itself.
import type { PublicExtension } from '../shared/types.js';
import { EXTENSION_CONTRACTS } from '../shared/types.js';
import { accessToken } from './auth.js';
import { clear, h } from './dom.js';

/** The article an extension slot is rendered for (latest version only). */
export interface ExtensionArticle {
  id: string;
  type: string;
  title: string;
  tags: string[];
  extra: Record<string, unknown>;
  canEdit: boolean;
  ownerName: string;
}

/** Host API, contract version 1. */
export interface ExtensionContext {
  contract: number;
  me: { username: string; role: 'admin' | 'editor' | 'viewer' };
  article?: ExtensionArticle;
  /** The signed-in user's access token (refreshed when close to expiry); null when signed out. */
  getAccessToken(): Promise<string | null>;
  navigate(path: string): void;
  /** Aborted when the user leaves the view: close sockets and timers with it. */
  signal: AbortSignal;
}

export interface ExtensionModule {
  id: string;
  contract: number;
  /** Shown in the sidebar link to /apps/<id>/. */
  title?: string;
  articleSlot?(ctx: ExtensionContext, el: HTMLElement): void | Promise<void>;
  page?(ctx: ExtensionContext, el: HTMLElement, subpath: string): void | Promise<void>;
}

type Status = 'loading' | 'ready' | 'failed' | 'unsupported';
interface State {
  info: PublicExtension;
  status: Status;
  module?: ExtensionModule;
  ready: Promise<void>;
  settle: () => void;
}

const LOAD_TIMEOUT_MS = 15_000;
const states = new Map<string, State>();
let onTitle: (id: string, title: string) => void = () => undefined;

export const isSupportedContract = (n: unknown): n is number => typeof n === 'number' && EXTENSION_CONTRACTS.includes(n);

/** Accepts a registration only for a configured, still loading extension with the configured contract. */
export function acceptRegistration(state: Pick<State, 'info' | 'status'> | undefined, mod: unknown): mod is ExtensionModule {
  if (!state || state.status !== 'loading' || !mod || typeof mod !== 'object') return false;
  const m = mod as Partial<ExtensionModule>;
  return m.id === state.info.id && m.contract === state.info.contract && isSupportedContract(m.contract);
}

function register(mod: unknown) {
  const id = (mod as { id?: unknown } | null)?.id;
  const state = typeof id === 'string' ? states.get(id) : undefined;
  if (!acceptRegistration(state, mod)) {
    console.error('mcpwiki: extension registration rejected', typeof id === 'string' ? id : '(no id)');
    if (state?.status === 'loading') ((state.status = 'unsupported'), state.settle());
    return;
  }
  state!.module = mod;
  state!.status = 'ready';
  if (typeof mod.title === 'string' && mod.title.trim()) onTitle(mod.id, mod.title.trim().slice(0, 40));
  state!.settle();
}

/** Starts loading every configured extension (once, at boot). */
export function loadExtensions(list: PublicExtension[] | undefined, titleChanged: (id: string, title: string) => void): void {
  onTitle = titleChanged;
  if (!list?.length) return;
  Object.defineProperty(globalThis, 'mcpwikiHost', {
    value: Object.freeze({ contracts: [...EXTENSION_CONTRACTS], register }),
    writable: false,
    configurable: false,
  });
  for (const info of list) {
    let settle = () => undefined as void;
    const ready = new Promise<void>((r) => (settle = r));
    const state: State = { info, status: isSupportedContract(info.contract) ? 'loading' : 'unsupported', ready, settle };
    states.set(info.id, state);
    if (state.status !== 'loading') {
      settle();
      continue;
    }
    const fail = () => {
      if (state.status === 'loading') ((state.status = 'failed'), settle());
    };
    const script = document.createElement('script');
    script.type = 'module';
    script.src = info.src;
    script.integrity = info.integrity; // a mismatch makes the browser refuse to run it ("error" event)
    script.crossOrigin = 'anonymous';
    // For module scripts "load" fires after evaluation: no register() call by then means a broken bundle.
    script.addEventListener('load', fail);
    script.addEventListener('error', fail);
    setTimeout(fail, LOAD_TIMEOUT_MS);
    document.head.appendChild(script);
  }
}

export const configuredExtensions = (): PublicExtension[] => [...states.values()].map((s) => s.info);

let view = new AbortController();
/** Called at the start of every route render: ends the previous view's extension work. */
export function newView(): AbortSignal {
  view.abort();
  view = new AbortController();
  return view.signal;
}

const MESSAGES: Record<Exclude<Status, 'loading' | 'ready'> | 'error', string> = {
  unsupported: 'は、この Wiki の版に対応していません。',
  failed: 'を読み込めませんでした。',
  error: 'でエラーが起きました。',
};
const notice = (id: string, kind: keyof typeof MESSAGES) => h('p', { class: 'muted ext-notice' }, `拡張「${id}」${MESSAGES[kind]}`);

async function run(state: State, el: HTMLElement, call: (m: ExtensionModule) => void | Promise<void> | undefined, showProblems: boolean, signal: AbortSignal) {
  await state.ready;
  if (signal.aborted) return;
  if (state.status !== 'ready') {
    if (showProblems) el.appendChild(notice(state.info.id, state.status === 'unsupported' ? 'unsupported' : 'failed'));
    return;
  }
  try {
    await call(state.module!);
  } catch (e) {
    console.error(`mcpwiki: extension ${state.info.id} failed`, e);
    if (!signal.aborted) {
      clear(el);
      if (showProblems) el.appendChild(notice(state.info.id, 'error'));
    }
  }
}

type Base = Omit<ExtensionContext, 'article' | 'signal' | 'contract'>;
export const hostBase = (me: ExtensionContext['me'], navigate: (path: string) => void): Base => ({
  me: { username: me.username, role: me.role },
  getAccessToken: () => accessToken(),
  navigate,
});

/**
 * One slot per extension below an article. Problems are shown to admins only (everyone else just sees no
 * slot), so a broken extension does not clutter every page.
 */
export function articleSlots(base: Base, article: ExtensionArticle, signal: AbortSignal): HTMLElement[] {
  return [...states.values()].map((state) => {
    const el = h('section', { class: 'ext-slot', 'data-ext': state.info.id });
    const ctx: ExtensionContext = { ...base, contract: state.info.contract, article: structuredClone(article), signal };
    void run(state, el, (m) => m.articleSlot?.(ctx, el), base.me.role === 'admin', signal);
    return el;
  });
}

/** The /apps/<id>/... page of an extension. */
export function extensionPage(base: Base, id: string, subpath: string, signal: AbortSignal): HTMLElement {
  const state = states.get(id);
  if (!state) return h('div', null, h('h1', null, '404'), h('p', null, 'ページが見つかりません。'));
  const el = h('div', { class: 'ext-page', 'data-ext': id });
  const ctx: ExtensionContext = { ...base, contract: state.info.contract, signal };
  void run(state, el, (m) => (m.page ? m.page(ctx, el, subpath) : void el.appendChild(h('p', { class: 'muted' }, 'この拡張には画面がありません。'))), true, signal);
  return el;
}
