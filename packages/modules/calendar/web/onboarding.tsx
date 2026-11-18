/** The calendar's onboarding question: reminders before events (`ask.tsx`). */
import type { OnboardingStepProps } from '@app/features/index';
import { ReminderQuestion } from './ask';

export default function CalendarOnboarding({ onNext }: OnboardingStepProps) {
  return <ReminderQuestion heading="h1" onDone={onNext} />;
}
