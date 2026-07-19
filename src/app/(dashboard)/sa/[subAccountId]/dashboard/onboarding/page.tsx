import { ClientOnboardingForm } from "@/components/onboarding/client-onboarding-form";

export default function ClientOnboardingPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-1 py-2">
      <h1 className="text-2xl font-bold tracking-tight">Client Onboarding</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Everything to fill in once, in one place, when a new client comes on
        board.
      </p>
      <ClientOnboardingForm />
    </div>
  );
}
