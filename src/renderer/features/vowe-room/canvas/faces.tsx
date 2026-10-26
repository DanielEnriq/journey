// The faces live with the one canvas engine (features/canvas/faces.tsx); the Desk's basis glyphs and
// anything else in the room import them from here.
export { BasisGlyph, BASIS_LABEL, Body, glyphFor, type Moment } from '../../canvas/faces.js';
export { captionFor as caption } from '../../canvas/faces-model.js';
export { timing, type Timing } from '../../canvas/story.js';
