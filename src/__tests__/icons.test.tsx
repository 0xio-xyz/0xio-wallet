import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as icons from 'src/shared/ui/icons';
import { MoreVertical, Star, X } from 'src/shared/ui/icons';

const X_PATH =
  'M4.83,4.83c0.64,-0.64 1.69,-0.64 2.33,0l4.83,4.83l4.83,-4.83c0.64,-0.64 1.69,-0.64 2.33,0c0.64,0.64 0.64,1.69 0,2.33l-4.83,4.83l4.83,4.83c0.64,0.64 0.64,1.69 0,2.33c-0.64,0.64 -1.69,0.64 -2.33,0l-4.83,-4.83l-4.83,4.83c-0.64,0.64 -1.69,0.64 -2.33,0c-0.64,-0.64 -0.64,-1.69 0,-2.33l4.83,-4.83l-4.83,-4.83c-0.64,-0.64 -0.64,-1.69 0,-2.33z';
const DOTS_PATH =
  'M9.8,5c0,-1.22 0.98,-2.2 2.2,-2.2c1.22,0 2.2,0.98 2.2,2.2c0,1.22 -0.98,2.2 -2.2,2.2c-1.22,0 -2.2,-0.98 -2.2,-2.2zM9.8,12c0,-1.22 0.98,-2.2 2.2,-2.2c1.22,0 2.2,0.98 2.2,2.2c0,1.22 -0.98,2.2 -2.2,2.2c-1.22,0 -2.2,-0.98 -2.2,-2.2zM9.8,19c0,-1.22 0.98,-2.2 2.2,-2.2c1.22,0 2.2,0.98 2.2,2.2c0,1.22 -0.98,2.2 -2.2,2.2c-1.22,0 -2.2,-0.98 -2.2,-2.2z';
const STAR_PATH =
  'M12.92,2.9l2.3,5.28l5.72,0.55c0.4,0.04 0.73,0.31 0.85,0.69c0.12,0.38 0.01,0.79 -0.29,1.06l-4.31,3.81l1.25,5.61c0.09,0.39 -0.07,0.79 -0.39,1.03c-0.32,0.23 -0.75,0.26 -1.1,0.05l-4.96,-2.92l-4.96,2.92c-0.34,0.2 -0.77,0.18 -1.1,-0.05c-0.32,-0.23 -0.47,-0.64 -0.39,-1.03l1.25,-5.61l-4.31,-3.81c-0.3,-0.26 -0.41,-0.68 -0.29,-1.06c0.12,-0.38 0.46,-0.65 0.85,-0.69l5.72,-0.55l2.3,-5.28c0.16,-0.37 0.52,-0.6 0.92,-0.6c0.4,0 0.76,0.24 0.92,0.6zM10.39,9.52c-0.14,0.33 -0.46,0.56 -0.82,0.6l-4.02,0.39l3.03,2.68c0.27,0.24 0.39,0.61 0.31,0.97l-0.88,3.94l3.49,-2.05c0.31,-0.18 0.7,-0.18 1.01,0l3.49,2.05l-0.88,-3.94c-0.08,-0.36 0.04,-0.73 0.31,-0.97l3.03,-2.68l-4.02,-0.39c-0.36,-0.03 -0.68,-0.26 -0.82,-0.6l-1.61,-3.71z';
const STAR_FILLED_PATH =
  'M12.92,2.9l2.3,5.28l5.72,0.55c0.4,0.04 0.73,0.31 0.85,0.69c0.12,0.38 0.01,0.79 -0.29,1.06l-4.31,3.81l1.25,5.61c0.09,0.39 -0.07,0.79 -0.39,1.03c-0.32,0.23 -0.75,0.26 -1.1,0.05l-4.96,-2.92l-4.96,2.92c-0.34,0.2 -0.77,0.18 -1.1,-0.05c-0.32,-0.23 -0.47,-0.64 -0.39,-1.03l1.25,-5.61l-4.31,-3.81c-0.3,-0.26 -0.41,-0.68 -0.29,-1.06c0.12,-0.38 0.46,-0.65 0.85,-0.69l5.72,-0.55l2.3,-5.28c0.16,-0.37 0.52,-0.6 0.92,-0.6c0.4,0 0.76,0.24 0.92,0.6z';
const open = (attrs: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}`;
const box = (size: number) => `width="${size}" height="${size}" viewBox="0 0 24 24"`;

describe('icons', () => {
  it('draws one filled path with the default attributes', () => {
    expect(renderToStaticMarkup(<X />)).toBe(
      `${open(`${box(24)} fill="currentColor"`)}><path d="${X_PATH}"></path></svg>`
    );
  });

  it('applies size, colour, class, style and aria attributes and drops stroke width', () => {
    expect(
      renderToStaticMarkup(
        <MoreVertical
          size={14}
          color="#fff"
          className="shrink-0"
          style={{ opacity: 0.5 }}
          aria-hidden
        />
      )
    ).toBe(
      `${open(`${box(14)} fill="#fff"`)} class="shrink-0" style="opacity:0.5" aria-hidden="true"><path d="${DOTS_PATH}"></path></svg>`
    );
  });

  it('draws the star as an outline, and solid when filled', () => {
    expect(renderToStaticMarkup(<Star size={11} />)).toContain(`<path d="${STAR_PATH}">`);
    expect(renderToStaticMarkup(<Star size={11} filled />)).toContain(
      `<path d="${STAR_FILLED_PATH}">`
    );
    expect(renderToStaticMarkup(<X filled />)).toContain(`<path d="${X_PATH}">`);
  });

  it('every icon renders one path of its own', () => {
    const all = Object.entries(icons);
    expect(all).toHaveLength(49);
    const seen = new Set<string>();
    for (const [name, Icon] of all) {
      const markup = renderToStaticMarkup(<Icon />);
      const d = /^<svg [^>]*><path d="(M[^"]+)"><\/path><\/svg>$/.exec(markup)?.[1];
      expect(d, name).toBeTruthy();
      expect(seen.has(d!), name).toBe(false);
      seen.add(d!);
    }
  });
});
