import { readFileSync } from 'fs';
import { join } from 'path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n, { type TFunction } from '../core';
import { Trans, useTranslation, withTranslation, type WithTranslation } from '../react';
import { fixture } from './fixture';

type TVector = [
  't',
  string,
  string,
  [(string | Record<string, unknown>)?, Record<string, unknown>?],
  string,
];
type TransVector = ['trans', string, Record<string, unknown>, string];

const vectors: (TVector | TransVector)[] = readFileSync(join(__dirname, 'vectors.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

const components = {
  terms: <a href="https://t" target="_blank" rel="noopener noreferrer" style={{ color: 'red' }} />,
  privacy: <b />,
};

beforeEach(() => {
  i18n.init({ resources: fixture, lng: 'en', fallbackLng: 'en' });
});

describe('translator matches the recorded vectors', () => {
  it('t', async () => {
    const rows = vectors.filter((v): v is TVector => v[0] === 't');
    expect(rows.length).toBeGreaterThan(500);
    for (const [, lng, key, args, want] of rows) {
      await i18n.changeLanguage(lng);
      expect(i18n.t(key, ...(args as [])), `${lng} ${key} ${JSON.stringify(args)}`).toBe(want);
    }
  });

  it('Trans', async () => {
    const rows = vectors.filter((v): v is TransVector => v[0] === 'trans');
    expect(rows.length).toBeGreaterThan(30);
    for (const [, lng, props, want] of rows) {
      await i18n.changeLanguage(lng);
      const html = renderToStaticMarkup(
        <Trans {...(props as { i18nKey: string })} components={components} />
      );
      expect(html, `${lng} ${JSON.stringify(props)}`).toBe(want);
    }
  });
});

describe('language store', () => {
  function Probe({ seen }: { seen: TFunction[] }) {
    const { t, i18n: api } = useTranslation();
    seen.push(t);
    return (
      <p>
        {t('common.close')} {api.language}
      </p>
    );
  }

  it('re-renders on a language change and keeps t stable otherwise', async () => {
    const seen: TFunction[] = [];
    const { rerender } = render(<Probe seen={seen} />);
    expect(screen.getByText('Close en')).toBeTruthy();
    rerender(<Probe seen={seen} />);
    expect(seen[1]).toBe(seen[0]);
    await act(() => i18n.changeLanguage('ja'));
    expect(screen.getByText('閉じる ja')).toBeTruthy();
    expect(seen[seen.length - 1]).not.toBe(seen[0]);
    const before = seen.length;
    await act(() => i18n.changeLanguage('ja'));
    expect(seen.length).toBe(before);
  });

  it('keeps an unknown language and falls back to English', async () => {
    await i18n.changeLanguage('fr');
    expect(i18n.language).toBe('fr');
    expect(i18n.resolvedLanguage).toBe('en');
    await i18n.changeLanguage('ja-JP');
    expect(i18n.resolvedLanguage).toBe('ja');
    await i18n.changeLanguage('fr');
    expect(i18n.t('greet', { name: 'A' })).toBe('Hello A');
  });

  it('returns the default or the key before init has resources', () => {
    i18n.init({ resources: {} });
    expect(i18n.t('common.close')).toBe('common.close');
    expect(i18n.t('common.close', { defaultValue: 'Close {{n}}', n: 1 })).toBe('Close 1');
  });

  it('blanks a variable passed as undefined and keeps one that is absent', () => {
    expect(i18n.t('greet', { name: undefined })).toBe('Hello ');
    expect(i18n.t('greet', {})).toBe('Hello {{name}}');
  });

  it('does not expand nested translation calls from a value', () => {
    expect(i18n.t('greet', { name: '$t(common.close)' })).toBe('Hello $t(common.close)');
  });
});

describe('withTranslation', () => {
  it('passes t, i18n and tReady', () => {
    const Inner = ({ t, tReady, label }: WithTranslation & { label: string }) => (
      <i>
        {label} {t('common.close')} {String(tReady)}
      </i>
    );
    const Wrapped = withTranslation()(Inner);
    expect(renderToStaticMarkup(<Wrapped label="x" />)).toBe('<i>x Close true</i>');
  });
});
