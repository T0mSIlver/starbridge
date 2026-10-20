import { cookies } from "next/headers";
import { AppProvider } from "@/components/AppProvider";
import { Gate } from "@/components/Gate";
import { JoinRequests } from "@/components/JoinRequests";
import { Shell } from "@/components/Shell";
import { DESKTOP_COOKIE, hasSession } from "@/lib/landing";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  // The desktop app is no visitor: signed out, it gets sign-in rather than the landing page.
  const visitor = !hasSession(jar) && !jar.has(DESKTOP_COOKIE);
  return (
    <AppProvider visitor={visitor}>
      <Gate visitor={visitor}>
        <Shell>
          <JoinRequests />
          {children}
        </Shell>
      </Gate>
    </AppProvider>
  );
}
