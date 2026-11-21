import {
  cloneElement,
  createElement,
  Fragment,
  isValidElement,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import i18n, { read, subscribe, type I18n, type TFunction, type TOptions } from './core';

export function useTranslation(): { t: TFunction; i18n: I18n; ready: boolean } {
  const s = useSyncExternalStore(subscribe, read, read);
  return { t: s.t, i18n, ready: true };
}

export interface WithTranslation {
  t: TFunction;
  i18n: I18n;
  tReady: boolean;
}

export function withTranslation() {
  return function wrap<P extends WithTranslation>(
    Inner: ComponentType<P>
  ): ComponentType<Omit<P, keyof WithTranslation>> {
    function Translated(props: Omit<P, keyof WithTranslation>) {
      const { t } = useTranslation();
      return createElement(Inner, { ...(props as P), t, i18n, tReady: true });
    }
    Translated.displayName = `withTranslation(${Inner.displayName || Inner.name || 'Component'})`;
    return Translated;
  };
}

type TransComponents = readonly ReactElement[] | Record<string, ReactElement>;

interface Tag {
  name: string;
  children: (string | Tag)[];
}

const TAG = /<(\/?)([A-Za-z0-9]+)\s*(\/?)>/g;

function parseTags(text: string): (string | Tag)[] {
  const root: (string | Tag)[] = [];
  const stack: Tag[] = [];
  const top = () => (stack.length ? stack[stack.length - 1].children : root);
  let last = 0;
  for (let m = TAG.exec(text); m; m = TAG.exec(text)) {
    const [whole, closing, name, selfClosing] = m;
    if (closing && (!stack.length || stack[stack.length - 1].name !== name)) continue;
    if (m.index > last) top().push(text.slice(last, m.index));
    last = m.index + whole.length;
    if (closing) {
      stack.pop();
    } else {
      const tag: Tag = { name, children: [] };
      top().push(tag);
      if (!selfClosing) stack.push(tag);
    }
  }
  if (last < text.length) top().push(text.slice(last));
  return root;
}

function renderTags(nodes: (string | Tag)[], components: TransComponents | undefined): ReactNode[] {
  return nodes.map((node, i) => {
    if (typeof node === 'string') return node;
    const el = components
      ? (components as Record<string, ReactElement | undefined>)[node.name]
      : undefined;
    const inner = renderTags(node.children, components);
    if (!isValidElement(el)) return `<${node.name}>${flatten(node.children)}</${node.name}>`;
    return inner.length ? cloneElement(el, { key: i }, ...inner) : cloneElement(el, { key: i });
  });
}

const flatten = (nodes: (string | Tag)[]): string =>
  nodes
    .map((n) => (typeof n === 'string' ? n : `<${n.name}>${flatten(n.children)}</${n.name}>`))
    .join('');

export function Trans({
  i18nKey,
  defaults,
  components,
  values,
  count,
}: {
  i18nKey: string;
  defaults?: string;
  components?: TransComponents;
  values?: TOptions;
  count?: number;
}): ReactElement {
  const { t } = useTranslation();
  const opts: TOptions = { ...values };
  if (count !== undefined) opts.count = count;
  if (defaults !== undefined) opts.defaultValue = defaults;
  return createElement(Fragment, null, ...renderTags(parseTags(t(i18nKey, opts)), components));
}
