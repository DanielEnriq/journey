// The room's record lives in shared/vowe/model.ts so main (the record writes) and the renderer share one
// definition; this re-export keeps the feature's imports local.
export * from '../../../../shared/vowe/model.js';
