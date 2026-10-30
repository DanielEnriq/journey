import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { makeUi } from './ui.js';

test('moving anywhere in the Desk puts down the full-screen composer', () => {
  const ui = makeUi();
  ui.setState({ fwrite: 'discuss', thread: null });
  ui.setState({ flash: 'x', tab: 'discuss' });
  assert.equal(ui.state.fwrite, 'discuss', 'nothing moved');
  ui.setState({ thread: 't1' });
  assert.equal(ui.state.fwrite, null);
  ui.setState({ fwrite: 'decide' });
  ui.setState({ depth: 'focus' });
  assert.equal(ui.state.fwrite, null);
});
