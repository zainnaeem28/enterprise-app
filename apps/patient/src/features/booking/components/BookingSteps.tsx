import { Stepper } from '@ehr/ui';

const STEPS = [
  { id: 'service', label: 'Service' },
  { id: 'doctor', label: 'Doctor and place' },
  { id: 'time', label: 'Date and time' },
  { id: 'confirm', label: 'Confirm' },
  { id: 'done', label: 'Booked' },
];

export function BookingSteps({ current }: { current: string }) {
  return <Stepper steps={STEPS} currentId={current} />;
}
