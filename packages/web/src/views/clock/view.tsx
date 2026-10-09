// Reloj de demo (`/app/clock`, docs/design-brief.md §6; FL-060, FL-084, FL-085, FL-086): the world's
// simulated time, what it waits for when it is busy, the moves of the clock, the next events and the demo
// controls; in a guest world "Saltar a escena"; and "Reiniciar este mundo". Everything reads the shell's
// clock (WorldClockContext), so the bar and this view never disagree.
import { PageHeader } from "../../components/PageHeader";
import { usePrincipal } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import type { ViewProps } from "../../lib/view-registry";
import { canDrive, isGuestWorld } from "./clock-model";
import { clockCopy as copy } from "./copy";
import { DemoControlsSection, EventsSection } from "./DemoSection";
import { NowSection } from "./NowSection";
import { ResetSection, ScenesSection } from "./SceneSection";

export default function ClockView(_props: ViewProps) {
  const { role, ispId } = usePrincipal();
  const drive = canDrive(role);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={consoleCopy.views.clock.title} description={consoleCopy.views.clock.description} />
      <NowSection />
      <EventsSection />
      <DemoControlsSection />
      {drive && isGuestWorld(ispId) ? <ScenesSection /> : null}
      {drive ? <ResetSection /> : <p className="text-sm text-slate">{copy.onlySupervisors}</p>}
    </div>
  );
}
