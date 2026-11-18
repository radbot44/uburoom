import { resolveName, glyphs } from '../shared/icons-data.mjs';
export * from '../shared/icons-data.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
export function icon(doc, name, seekSeconds = 15) {
  const asset = resolveName(name, seekSeconds);
  if (!asset || !Object.hasOwn(glyphs, asset)) throw new Error('Unknown uburoom icon: ' + name);
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', asset === 'oomark' ? '528.41 544.4 298.99 249.1061' : '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', asset === 'oomark' ? 'butt' : 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-tabler-icon', asset === 'oomark' ? 'oomark' : asset);
  if (asset === 'oomark') svg.setAttribute('class', 'oomark-icon');
  const use = doc.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#icon-' + asset);
  svg.append(use);
  return svg;
}
