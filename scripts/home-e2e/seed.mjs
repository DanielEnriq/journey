// Other people, doing ordinary things in rooms you belong to, so a test account's Inbox has genuine work in
// it: a decision waiting on your signature, a thread waiting on your reply, a plan whose doer stopped to ask
// you, and an invitation to a room you're not in yet. Everything goes through the app's own Supabase
// services (dist/integrations/supabase), as those people, against a LOCAL stack; nothing is written to the
// Inbox directly. Run it after the test account has signed in once (scripts/home-e2e/launch.mjs).
//
//   pnpm build
//   SUPABASE_URL=http://127.0.0.1:<port> SUPABASE_PUBLISHABLE_KEY=… ROOMS_TEST_SUPABASE_SECRET_KEY=… \
//   node scripts/home-e2e/seed.mjs <login of the signed-in test account>
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.ROOMS_TEST_SUPABASE_SECRET_KEY;
const login = process.argv[2];
if (!url || !publishableKey || !secretKey || !login) throw new Error('Usage: SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… ROOMS_TEST_SUPABASE_SECRET_KEY=… node scripts/home-e2e/seed.mjs <login>');
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('Seeds only a local stack');

const { createRoomService } = await import('../../dist/integrations/supabase/rooms.js');
const { createVoweRecordService } = await import('../../dist/integrations/supabase/vowe-record.js');
const { createInvitationService } = await import('../../dist/integrations/supabase/invitations.js');

const quiet = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, secretKey, quiet);
const run = randomUUID().slice(0, 6);
const password = `pw-${randomUUID()}`;

const { data: listed, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (listError) throw listError;
const me = listed.users.find((u) => u.email === `${login}@gh.test`);
if (!me) throw new Error(`${login}@gh.test hasn't signed in yet: launch the app and Continue with GitHub first`);

async function person(name) {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}-${run}@vowe.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  const cloud = createClient(url, publishableKey, quiet);
  const { error: signInError } = await cloud.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  const client = async () => cloud;
  return { id: data.user.id, name, cloud, rooms: createRoomService(client), vowe: createVoweRecordService(client), invites: createInvitationService(client) };
}

const bea = await person('Bea Park');
const cy = await person('Cy Ortiz');

const { data: ws, error: wsError } = await bea.cloud.from('workspaces').insert({ name: `Northwind ${run}` }).select().single();
if (wsError) throw wsError;
const { error: wmError } = await bea.cloud.from('workspace_members').insert([{ workspace_id: ws.id, user_id: me.id }, { workspace_id: ws.id, user_id: cy.id }]);
if (wmError) throw wmError;

// Checkout: Bea owns it; you and Cy are members. Bea asks you to sign a decision, and waits on your reply.
const checkout = (await bea.rooms.createRoom({ workspaceId: ws.id, name: 'Checkout revamp', goal: 'Charge customers once, at the right moment', repository: 'github.com/northwind/checkout' })).id;
await bea.rooms.addMember(checkout, me.id);
await bea.rooms.addMember(checkout, cy.id);
const { id: decision } = await bea.vowe.createDecision(checkout, { title: 'Charge on fulfillment, not at order', problem: 'Refunds for items that never ship cost us fees twice.' });
await bea.vowe.addLine(checkout, decision, 'because', 'Most refunds are for out-of-stock items charged at order time.');
await bea.vowe.addLine(checkout, decision, 'assume', 'Card authorizations stay valid for 7 days.');
await bea.vowe.requestSignatures(checkout, decision, [me.id, cy.id]);
await cy.vowe.sign(checkout, decision, 1);
const { id: thread } = await bea.vowe.createThread(checkout, {
  about: { kind: 'part', id: 'payments-api', name: 'Payments API' },
  body: 'Does the Payments API retry captures on its own, or do we need a job for it?', waiting: me.id,
});

// Billing: Cy owns it; you're a member. Cy's plan stops to ask you a question.
const billing = (await cy.rooms.createRoom({ workspaceId: ws.id, name: 'Billing migration', goal: 'Move invoices to the new ledger' })).id;
await cy.rooms.addMember(billing, me.id);
const { id: work } = await cy.vowe.createWork(billing, { title: 'Backfill invoice ledger', objective: 'Every invoice since 2024 is in the ledger, with totals that match.' });
const { id: question } = await cy.vowe.ask(billing, work, { text: 'Should credit notes go in as negative invoices or as their own entries?', for: me.id, options: ['Negative invoices', 'Their own entries'] });

// Search: Bea invites you by email; you're not a member yet.
const search = (await bea.rooms.createRoom({ workspaceId: ws.id, name: 'Search relevance' })).id;
await bea.invites.send(search, [`${login}@gh.test`], 'member');

console.log(JSON.stringify({ workspace: ws.id, rooms: { checkout, billing, search }, decision, thread, work, question, people: { bea: bea.id, cy: cy.id } }, null, 2));
