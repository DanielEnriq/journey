/**
 * Every mock data source reports what it pretended to do here, so a scripted result is never mistaken for
 * a real one: open DevTools and filter the console by "vowe mock".
 */
export function mockLog(source: string, action: string, detail?: unknown) {
  if (detail === undefined) console.info(`[vowe mock] ${source}: ${action}`);
  else console.info(`[vowe mock] ${source}: ${action}`, detail);
}
