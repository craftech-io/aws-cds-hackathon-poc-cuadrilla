// The scenarios of the runner and its suites (docs/test-plan.md §4.5, §6): `smoke` is `SC-00` (each deploy),
// `full` every scenario `SC-00` … `SC-20` (by `workflow_dispatch`, with the CTO's OK: it spends Bedrock).
// `SC-19` goes before `SC-18` and `SC-17` after both: the three share the test guest's world (lane `guest-test`).
import sc00 from "../sc-00-smoke";
import sc01 from "../sc-01-day-start";
import sc02 from "../sc-02-voice-diagnosis";
import sc03 from "../sc-03-manual";
import sc04 from "../sc-04-photos";
import sc05 from "../sc-05-closing";
import sc06 from "../sc-06-ladder";
import sc07 from "../sc-07-take-and-answer";
import sc08 from "../sc-08-safety";
import sc09 from "../sc-09-plan-b";
import sc10 from "../sc-10-people-consent";
import sc11 from "../sc-11-policy";
import sc12 from "../sc-12-channel-injection";
import sc13 from "../sc-13-console-roles";
import sc14 from "../sc-14-failures";
import sc15 from "../sc-15-memory";
import sc16 from "../sc-16-audit-isolation";
import sc17 from "../sc-17-whatsapp-live";
import sc18 from "../sc-18-guest-tour";
import sc19 from "../sc-19-guest-world";
import sc20 from "../sc-20-signup";
import type { ScenarioDef, Suite } from "./steps";

export const SCENARIOS: readonly ScenarioDef[] = [sc00, sc01, sc02, sc03, sc04, sc05, sc06, sc07, sc08, sc09, sc10, sc11, sc12, sc13, sc14, sc15, sc16, sc19, sc18, sc17, sc20];

export function scenariosOf(suite: Suite, only?: readonly string[]): ScenarioDef[] {
  return SCENARIOS.filter((scenario) => scenario.suites.includes(suite) && (only === undefined || only.includes(scenario.id)));
}
