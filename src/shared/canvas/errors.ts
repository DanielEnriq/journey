// Every way a canvas command can fail, as a code a caller can branch on and a sentence a person can read.

export type CanvasErrorCode =
  /** The command or document is malformed: a missing field, an unknown kind, a bad id. */
  | 'invalid'
  /** It names a component, view, annotation or proposal that isn't in the document. */
  | 'not-found'
  /** It would create something that already exists, or undo something changed since. */
  | 'conflict'
  /** The actor may not do this: Vowe accepting its own proposal, a viewer editing. */
  | 'forbidden'
  /** The command is well-formed but the system can't be drawn that way (e.g. no queue to fail from). */
  | 'unsupported'
  /** The room refused: not a member, or not allowed to edit. */
  | 'permission-denied'
  /** Saving lost the race too many times in a row; the latest document is unchanged. */
  | 'busy'
  | 'network'
  | 'signed-out'
  | 'unknown';

export class CanvasError extends Error {
  constructor(readonly code: CanvasErrorCode, message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'CanvasError';
  }
}

export const invalid = (message: string, path?: string) => new CanvasError('invalid', message, path);
