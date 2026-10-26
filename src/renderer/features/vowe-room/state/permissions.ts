import { can } from '../../membership/model.js';
import type { RoomRole } from '../contracts/model.js';

// The Desk asks these; it never tests roles itself. They map onto Journey's permission matrix
// (features/membership/model.ts) so the Desk and the rest of the room can't disagree:
//   write    edit plans and decision drafts, accept or reject suggested changes, add work  → edit_canvas
//   sign     sign, request changes, approve and authorize a plan version                   → sign_decision
//   comment  reply, comment on a passage, react                                             → comment
// Journey has no plan or authorization abilities yet; BACKEND_HANDOFF.md proposes adding them.
export const mayWrite = (role: RoomRole | null | undefined) => can(role, 'edit_canvas');
export const maySign = (role: RoomRole | null | undefined) => can(role, 'sign_decision');
export const mayComment = (role: RoomRole | null | undefined) => can(role, 'comment');
